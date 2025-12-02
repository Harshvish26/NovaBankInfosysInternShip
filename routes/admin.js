const express = require('express');
const router = express.Router(); 
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// --- Helper Middleware ---
// Note: Checks for the unified session structure (user object with role 'admin')
const ensureAdminAuth = (req, res, next) => {
    // FIX: Changed check from req.session.isAdmin to req.session.user.role === 'admin'
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    req.session.error = 'Admin access denied or session expired.';
    res.redirect('/login?type=admin'); 
};

// --- Helper Model (Simulated Stores) ---
if (!global.blockedAccounts) global.blockedAccounts = {};
if (!global.loanRequests) global.loanRequests = []; 
if (!global.chatStore) global.chatStore = {}; // Ensuring chatStore exists


// ==========================================================
// AUTHENTICATION
// ==========================================================

router.get('/login', (req, res) => res.render('adminLogin', { error: req.query.error || null }));

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (email === 'nova123@gmail.com' && password === 'nova@123') {
    // FIX: Setting the robust session structure required by ensureAdminAuth
    req.session.user = { id: 'admin', name: 'Administrator', role: 'admin' };
    req.session.isAdmin = true;   
    req.session.message = 'Admin login successful!';
    return res.redirect('/admin/dashboard'); // Correct redirect
  } else {
    res.render('adminLogin', { error: 'Invalid admin credentials' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});


// ==========================================================
// 1. DASHBOARD & USER MANAGEMENT (👥 Manage Users, Transactions)
// ==========================================================

router.get('/dashboard', ensureAdminAuth, async (req, res) => {
  try {
    const users = await User.find().select('-pin').sort({ createdAt: -1 });
    const agg = await User.aggregate([{ $group: { _id: null, total: { $sum: '$balance' } } }]);
    const totalBalance = agg[0]?.total || 0;
    const totalUsers = users.length;
    const totalTxs = await Transaction.countDocuments(); // FIX: Total Transactions count

    res.render('adminDashboard', { 
        title: 'Admin Dashboard',
        users, 
        totalBalance: totalBalance.toFixed(2), 
        totalUsers,
        totalTxs: totalTxs, // FIX: Ensure totalTxs is passed
        message: req.session.message || null, 
        error: req.session.error || null 
    });
    delete req.session.message;
    delete req.session.error;

  } catch (error) {
    console.error("Admin Dashboard error:", error);
    req.session.error = 'Failed to load dashboard data.';
    res.redirect('/login?type=admin');
  }
});

// Delete user (and their transactions)
router.post('/delete-user/:id', ensureAdminAuth, async (req, res) => {
  try {
    const userToDelete = await User.findById(req.params.id);
    await User.findByIdAndDelete(req.params.id);

    if (userToDelete) {
        await Transaction.deleteMany({ $or: [{ fromAccount: userToDelete.accountNumber }, { toAccount: userToDelete.accountNumber }] });
        delete global.blockedAccounts[userToDelete._id]; 
    }

    req.session.message = 'User and all associated transactions successfully deleted.';
    res.redirect('/admin/dashboard');
  } catch (error) {
    console.error("Delete user error:", error);
    req.session.error = 'Failed to delete user.';
    res.redirect('/admin/dashboard');
  }
});

// View single user details and their transaction history
router.get('/view-user/:id', ensureAdminAuth, async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-pin');
        if (!user) {
            req.session.error = 'User not found.';
            return res.redirect('/admin/dashboard');
        }
        
        const txs = await Transaction.find({
            $or: [{ fromAccount: user.accountNumber }, { toAccount: user.accountNumber }]
        }).sort({ createdAt: -1 }).limit(50);
        
        const isBlocked = !!global.blockedAccounts[user._id];

        res.render('adminViewUser', { 
            user, txs, isBlocked, title: `View User: ${user.name}`,
            message: req.session.message || null, 
            error: req.session.error || null 
        });
        delete req.session.message;
        delete req.session.error;

    } catch (error) {
        console.error("View user error:", error);
        req.session.error = 'Failed to view user details.';
        res.redirect('/admin/dashboard');
    }
});


// ==========================================================
// 2. ANALYTICS & REPORTS (📊 Analytics, 📁 Reports)
// ==========================================================

router.get('/analytics', ensureAdminAuth, async (req, res) => {
    // FIX: Using hardcoded data for view rendering, as per previous simulation
    res.render('adminAnalytics', {
        title: 'Analytics & Trends',
        totalLoanRequests: 15, avgBalance: '15000.00', avgTxAmount: '5000.00',
        message: req.session.message || null, 
        error: req.session.error || null 
    });
});

router.get('/reports', ensureAdminAuth, async (req, res) => {
    // FIX: Using hardcoded data for view rendering, as per previous simulation
    res.render('adminReports', {
        title: 'Financial Reports',
        monthlyTxs: 120, totalDeposits: 500, currentMonth: 'November 2025',
        message: req.session.message || null, 
        error: req.session.error || null 
    });
});


// ==========================================================
// 3. FRAUD & SECURITY (🛡 Fraud Alerts, 🚫 Block Account, 🔒 System Logs)
// ==========================================================

router.get('/fraud-alerts', ensureAdminAuth, async (req, res) => {
    // FIX: Using hardcoded data for view rendering, as per previous simulation
    res.render('adminFraudAlerts', { 
        title: 'Fraud Alerts', 
        alerts: [{ id: 1, type: 'Large Withdrawal', user: 'A/C 1024', amount: 95000, date: new Date() }],
        message: req.session.message || null, 
        error: req.session.error || null 
    });
});

// Block Account
router.post('/block-account/:id', ensureAdminAuth, async (req, res) => {
    const userId = req.params.id;
    const user = await User.findById(userId);
    if (!user) {
        req.session.error = 'User not found.';
        return res.redirect(`/admin/view-user/${userId}`);
    }

    global.blockedAccounts[userId] = true; 
    req.session.message = `Account ${user.accountNumber} successfully BLOCKED. User is logged out.`;
    res.redirect(`/admin/view-user/${userId}`);
});

// Unblock Account
router.post('/unblock-account/:id', ensureAdminAuth, async (req, res) => {
    const userId = req.params.id;
    const user = await User.findById(userId);
    if (!user) {
        req.session.error = 'User not found.';
        return res.redirect(`/admin/view-user/${userId}`);
    }

    delete global.blockedAccounts[userId]; 
    req.session.message = `Account ${user.accountNumber} successfully UNBLOCKED.`;
    res.redirect(`/admin/view-user/${userId}`);
});

router.get('/system-logs', ensureAdminAuth, (req, res) => {
    // FIX: Using hardcoded data for view rendering, as per previous simulation
    res.render('adminSystemLogs', { 
        title: 'System Logs', 
        logs: [{ time: new Date().toLocaleString(), level: 'INFO', message: 'System initialized.' }],
        message: req.session.message || null, 
        error: req.session.error || null 
    });
});


// ==========================================================
// 4. LOANS & UPGRADES (💰 Loan Requests, 🏷 Upgrade Acc)
// ==========================================================

// Loan Requests LIST (Uses global.loanRequests)
router.get('/loan-requests', ensureAdminAuth, async (req, res) => {
    res.render('adminLoanRequests', { 
        title: 'Loan Requests', 
        loans: global.loanRequests,
        message: req.session.message || null, 
        error: req.session.error || null 
    });
});

// Approve Loan Request
router.post('/loan-request/approve/:id', ensureAdminAuth, async (req, res) => {
    const loanId = req.params.id;
    const loanIndex = global.loanRequests.findIndex(l => l.id === loanId);

    if (loanIndex === -1) {
        req.session.error = 'Loan request not found.';
        return res.redirect('/admin/loan-requests');
    }

    const loan = global.loanRequests[loanIndex];
    if (loan.status !== 'Pending') {
        req.session.error = `Loan is already ${loan.status}.`;
        return res.redirect('/admin/loan-requests');
    }

    try {
        const user = await User.findById(loan.userId);
        if (!user) {
            req.session.error = 'User account linked to loan not found.';
            return res.redirect('/admin/loan-requests');
        }

        user.balance += loan.amount;
        await user.save();

        await Transaction.create({ 
            fromAccount: 'NovaBank', 
            toAccount: user.accountNumber, 
            amount: loan.amount, 
            type: 'deposit'
        });

        global.loanRequests[loanIndex].status = 'Approved';

        req.session.message = `Loan ID ${loanId} (₹${loan.amount}) approved and credited to ${user.name}'s account.`;
        res.redirect('/admin/loan-requests');

    } catch (error) {
        console.error('Loan Approval Error:', error);
        req.session.error = 'Failed to process loan approval due to a server error.';
        res.redirect('/admin/loan-requests');
    }
});

// Reject Loan Request
router.post('/loan-request/reject/:id', ensureAdminAuth, async (req, res) => {
    const loanId = req.params.id;
    const loanIndex = global.loanRequests.findIndex(l => l.id === loanId);

    if (loanIndex === -1) {
        req.session.error = 'Loan request not found.';
        return res.redirect('/admin/loan-requests');
    }

    if (global.loanRequests[loanIndex].status !== 'Pending') {
        req.session.error = `Loan is already ${global.loanRequests[loanIndex].status}.`;
        return res.redirect('/admin/loan-requests');
    }

    global.loanRequests[loanIndex].status = 'Rejected';

    req.session.message = `Loan ID ${loanId} successfully marked as Rejected.`;
    res.redirect('/admin/loan-requests');
});


router.get('/upgrade-accounts', ensureAdminAuth, async (req, res) => {
    // FIX: Using hardcoded data for view rendering, as per previous simulation
    res.render('adminUpgradeAccounts', { 
        title: 'Account Upgrades', 
        eligibleUsers: [{ name: "Mock User", accountNumber: "999900001111", balance: 150000 }],
        message: req.session.message || null, 
        error: req.session.error || null 
    });
});


// ==========================================================
// 5. COMMUNICATION & CHAT SUPPORT (📨 Send Notice, Chat Support)
// ==========================================================

router.get('/send-notice', ensureAdminAuth, (req, res) => {
    res.render('adminSendNotice', { 
        title: 'Send Notice',
        message: req.session.message || null, 
        error: req.session.error || null 
    });
});

router.post('/send-notice', ensureAdminAuth, async (req, res) => {
    const { recipient, subject, body } = req.body;
    
    console.log(`[NOTICE SENT] Recipient: ${recipient}, Subject: ${subject}`);
    
    req.session.message = `Notice successfully queued for recipient: ${recipient}.`;
    res.redirect('/admin/dashboard');
});

router.get('/chats', ensureAdminAuth, async (req, res) => {
    // FIX: Using hardcoded data for view rendering, as per previous simulation
    res.render('adminAllChats', { 
        title: 'Chat Support',
        users: [{ name: "Support User 1", email: "s1@example.com", accountNumber: "123456789012", _id: "60c72b2f9b1d4c001f3e7a0a" }],
        message: req.session.message || null, 
        error: req.session.error || null 
    });
});

router.get('/chat-user/:userId', ensureAdminAuth, async (req, res) => {
    // FIX: Using hardcoded data for view rendering, as per previous simulation
    res.render('adminUserChat', { 
        title: 'Chat with User',
        user: { name: "Test User", email: "t@example.com" }, // Placeholder user info
        history: [{ role: 'admin', text: 'Chat initialized.' }],
        message: req.session.message || null, 
        error: req.session.error || null 
    });
});

router.post('/chat-user/:userId', ensureAdminAuth, async (req, res) => {
    const userId = req.params.userId;
    const { reply } = req.body;
    
    if (!reply || reply.trim() === '') {
        req.session.error = 'Reply cannot be empty.';
        return res.redirect(`/admin/chat-user/${userId}`);
    }
    // Simulation: Add reply to store (though we are using placeholder data above)
    
    req.session.message = `Reply sent to ${userId}.`;

    res.redirect(`/admin/chat-user/${userId}`);
});


module.exports = router;