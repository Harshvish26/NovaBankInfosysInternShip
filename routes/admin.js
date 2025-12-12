const express = require('express');
const router = express.Router(); 
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const AccountClosureRequest = require('../models/AccountClosureRequest');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

let transporter = null;

// Nodemailer Transporter Configuration using Environment Variables
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, // Use TLS (Port 587)
        auth: { 
            user: process.env.EMAIL_USER, 
            pass: process.env.EMAIL_PASS 
        },
        // Add this line for better security/compatibility
        tls: { rejectUnauthorized: false } 
    });
    console.log("Nodemailer transporter initialized for Admin Router.");
} else {
    console.warn("WARNING: EMAIL_USER or EMAIL_PASS environment variables are missing. Email sending functionality is disabled.");
}

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
    try {
        const totalLoanRequests = global.loanRequests.length;
        
        // Calculate Average Balance
        const avgBalanceResult = await User.aggregate([{ $group: { _id: null, avgBalance: { $avg: '$balance' } } }]);
        const avgBalance = avgBalanceResult[0]?.avgBalance || 0;

        // Calculate Average Transaction Amount
        const avgTxResult = await Transaction.aggregate([{ $group: { _id: null, avgAmount: { $avg: '$amount' } } }]);
        const avgTxAmount = avgTxResult[0]?.avgAmount || 0;

        res.render('adminAnalytics', {
            title: 'Analytics & Trends',
            totalLoanRequests,
            avgBalance: avgBalance.toFixed(2), 
            avgTxAmount: avgTxAmount.toFixed(2),
            message: req.session.message || null, 
            error: req.session.error || null 
        });
    } catch (error) {
        console.error("Analytics error:", error);
        req.session.error = 'Failed to load analytics data.';
        res.redirect('/admin/dashboard');
    }
});

router.get('/reports', ensureAdminAuth, async (req, res) => {
    try {
        const today = new Date();
        const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        
        const monthlyTxs = await Transaction.find({ createdAt: { $gte: startOfMonth } }).countDocuments();
        const totalDeposits = await Transaction.find({ type: 'deposit' }).countDocuments();

        res.render('adminReports', {
            title: 'Financial Reports',
            monthlyTxs,
            totalDeposits,
            currentMonth: startOfMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
            message: req.session.message || null, 
            error: req.session.error || null 
        });
    } catch (error) {
        console.error("Reports error:", error);
        req.session.error = 'Failed to generate reports.';
        res.redirect('/admin/dashboard');
    }
});


router.get('/fraud-alerts', ensureAdminAuth, async (req, res) => {
    try {
        // 1. Fetch large transactions (REMOVED .populate() to fix the error)
        const largeTxs = await Transaction.find({ amount: { $gte: 50000 } })
            .sort({ createdAt: -1 })
            .limit(10);
            
        // 2. Collect unique account numbers (excluding system accounts like 'bank' or 'cash')
        const accountNumbers = [...new Set(largeTxs.map(tx => tx.fromAccount).filter(acc => acc !== 'bank' && acc !== 'cash' && acc !== 'cash' && acc !== 'NovaBank'))];
        
        // 3. Fetch User Name and ID for the relevant accounts in one go
        const users = await User.find({ accountNumber: { $in: accountNumbers } }).select('name accountNumber');
        
        // 4. Create a quick lookup map { accountNumber: { name, id } }
        const userMap = users.reduce((map, user) => {
            map[user.accountNumber] = { name: user.name, id: user._id };
            return map;
        }, {});


        // 5. Transform into Alert structure, using User Name if found
        const alerts = largeTxs.map(tx => {
            const senderAcc = tx.fromAccount;
            const senderDetails = userMap[senderAcc];
            
            return {
                id: tx._id, // Transaction ID
                userId: senderDetails ? senderDetails.id : null, // Used for 'Investigate' button
                type: tx.type === 'deposit' ? 'Large Deposit' : 'Large Withdrawal/Transfer',
                // Display User Name OR the account number/source
                user: senderDetails ? senderDetails.name : senderAcc, 
                amount: tx.amount,
                date: tx.createdAt
            };
        });
        
        res.render('adminFraudAlerts', { 
            title: 'Fraud Alerts', 
            alerts,
            message: req.session.message || null, 
            error: req.session.error || null 
        });

    } catch (error) {
        console.error("Fraud Alerts error:", error);
        req.session.error = 'Failed to load fraud alerts data.';
        res.redirect('/admin/dashboard');
    }
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
    // FIX: Using hardcoded data for view rendering, but with better formatting
    const mockLogs = [
        { time: new Date(Date.now() - 60000).toLocaleString(), level: 'INFO', message: 'Admin login attempt successful.' },
        { time: new Date(Date.now() - 120000).toLocaleString(), level: 'WARNING', message: 'LoanStore array full; data overflow imminent.' },
        { time: new Date(Date.now() - 180000).toLocaleString(), level: 'ERROR', message: 'Failed MongoDB connection attempt.' },
    ];
    res.render('adminSystemLogs', { 
        title: 'System Logs', 
        logs: mockLogs,
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
    // Eligibility: Users with balance > 50,000
    const eligibleUsers = await User.find({ balance: { $gte: 50000 } }).select('name accountNumber balance');

    res.render('adminUpgradeAccounts', { 
        title: 'Account Upgrades', 
        eligibleUsers,
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

// UPDATED POST ROUTE FOR SENDING EMAIL

router.post('/send-notice', ensureAdminAuth, async (req, res) => {
    const { recipient, email_ac, subject, body } = req.body;
    
    // Check if transporter is configured before attempting to send
    if (!transporter) {
        req.session.error = 'Email service is not configured on the server.';
        return res.redirect('/admin/send-notice');
    }

    try {
        let recipientEmails = [];

        // 1. Determine Target Emails
        if (recipient === 'all') {
            // Fetch all user emails
            const users = await User.find({}).select('email');
            recipientEmails = users.map(user => user.email).filter(email => email);

        } else if (recipient === 'specific' && email_ac) {
            // Treat the input as the target email/account number
            if (email_ac.includes('@')) {
                 recipientEmails.push(email_ac.trim());
            } else {
                // Assuming email_ac is an account number, find the user's email
                const user = await User.findOne({ accountNumber: email_ac }).select('email');
                if (user && user.email) {
                    recipientEmails.push(user.email);
                }
            }

        } else {
            req.session.error = 'Invalid recipient selection or specific target missing.';
            return res.redirect('/admin/send-notice');
        }

        if (recipientEmails.length === 0) {
            req.session.error = 'No valid recipients found to send the notice.';
            return res.redirect('/admin/send-notice');
        }

        // 2. Prepare Email and Send
        const mailOptions = {
            // Use the configured user email as the sender address
            from: `NovaBank Admin <${process.env.EMAIL_USER}>`, 
            to: recipientEmails.join(', '), 
            subject: subject,
            html: `<p>Dear Customer,</p>
                   <p style="white-space: pre-wrap; margin: 15px 0; padding: 10px; border-left: 3px solid #007bff; background-color: #f8f9fa;">${body}</p>
                   <p>Regards,<br>Nova Bank Administration</p>`
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[EMAIL SENT] Target: ${recipient} (${recipientEmails.length} recipients) | Message ID: ${info.messageId}`);
        
        req.session.message = `Notice successfully sent to ${recipientEmails.length} recipient(s).`;
        res.redirect('/admin/dashboard');

    } catch (error) {
        console.error('Email sending error:', error);
        req.session.error = 'Failed to send notice. Check server logs and environment variables.';
        res.redirect('/admin/send-notice');
    }
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


// ==========================================================
// X. FINANCIAL REPORT DOWNLOAD (ADMIN)
// ==========================================================

router.get('/download-system-report', ensureAdminAuth, async (req, res) => {
    try {
        // 1. Fetch ALL Transactions (System-wide report)
        const allTxs = await Transaction.find({})
            .sort({ createdAt: -1 });

        // 2. Fetch ALL Users (Required for mapping account numbers to names)
        const allUsers = await User.find({}).select('name accountNumber');
        const userMap = allUsers.reduce((map, user) => {
            map[user.accountNumber] = user.name;
            return map;
        }, {});


        // 3. Initialize PDF Document
        const doc = new PDFDocument({ 
            size: 'A4', 
            margins: { top: 50, bottom: 50, left: 50, right: 50 } 
        });

        const filename = `NovaBank_ADMIN_Report_${new Date().toISOString().slice(0, 10)}.pdf`;

        // Set Headers for Download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);

        // --- 4. PROFESSIONAL PDF DESIGN AND FORMATTING (Admin View) ---

        // A. Title Header
        doc.font('Helvetica-Bold').fontSize(24).fillColor('#4F46E5').text('NOVA BANK SYSTEM-WIDE FINANCIAL REPORT', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(12).fillColor('#6B7280').text(`Date Generated: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.lineWidth(1).strokeColor('#4F46E5').moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(1.5);

        // B. Summary Statistics (Based on Image 39a7d0.png)
        doc.fontSize(16).fillColor('#1F2937').text('Operational Summary:', { underline: true });
        doc.moveDown(0.5);
        
        // Calculate basic stats (Must match your Financial Reports view logic)
        const totalDeposits = allTxs.filter(tx => tx.type === 'deposit').length;
        const totalTransactions = allTxs.length;

        doc.fontSize(12).fillColor('#4B5563');
        doc.text(`Total Transactions (All Time): ${totalTransactions}`, 50, doc.y, { continued: true })
           .text(`Total Deposits (Count): ${totalDeposits}`, 300, doc.y);
        doc.moveDown(1.5);
        
        doc.lineWidth(0.5).strokeColor('#E5E7EB').moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(1.5);


        // C. Full Transaction Details Table
        doc.fontSize(16).fillColor('#4F46E5').text('Full Transaction Log:', { underline: true });
        doc.moveDown(0.5);

        const COLUMNS = [
            { id: 'Date', x: 50, width: 60, align: 'left' },
            { id: 'Type', x: 120, width: 60, align: 'left' },
            { id: 'Source/Sender', x: 190, width: 140, align: 'left' },
            { id: 'Recipient/Target', x: 340, width: 140, align: 'left' },
            { id: 'Amount (₹)', x: 480, width: 70, align: 'right' }
        ];
        
        // Function to draw the header row
        const drawHeader = () => {
            let headerY = doc.y;
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#4B5563');
            COLUMNS.forEach(col => {
                doc.text(col.id.toUpperCase(), col.x, headerY, { width: col.width, align: col.align });
            });
            doc.moveDown(0.5);
            doc.strokeColor('#D1D5DB').lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            doc.moveDown(0.5);
        };
        
        drawHeader(); // Initial header
        
        // Draw Table Rows
        doc.font('Helvetica').fontSize(8).fillColor('#1F2937');
        
        allTxs.forEach(tx => {
            // Check for pagination
            if (doc.y + 20 > doc.page.height - doc.page.margins.bottom) {
                doc.addPage();
                drawHeader();
            }
            
            const isDebit = tx.fromAccount !== 'bank' && tx.fromAccount !== 'cash'; // System/user perspective
            const flowColor = isDebit ? '#EF4444' : '#10B981'; 
            const senderName = userMap[tx.fromAccount] || tx.fromAccount;
            const recipientName = userMap[tx.toAccount] || tx.toAccount;

            let rowY = doc.y;
            
            // 1. Date
            doc.text(tx.createdAt.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }), COLUMNS[0].x, rowY, { width: COLUMNS[0].width, align: COLUMNS[0].align });

            // 2. Type
            doc.text(tx.type.toUpperCase(), COLUMNS[1].x, rowY, { width: COLUMNS[1].width, align: COLUMNS[1].align });
            
            // 3. Source/Sender Name
            doc.text(senderName, COLUMNS[2].x, rowY, { width: COLUMNS[2].width, align: COLUMNS[2].align });
            
            // 4. Recipient/Target Name
            doc.text(recipientName, COLUMNS[3].x, rowY, { width: COLUMNS[3].width, align: COLUMNS[3].align });

            // 5. Amount (Aligned Right & Colored)
            doc.fillColor(flowColor).text(`₹ ${tx.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, COLUMNS[4].x, rowY, { width: COLUMNS[4].width, align: COLUMNS[4].align });

            doc.moveDown(1);
        });
        
        // Finalize PDF
        doc.end();

    } catch (err) {
        console.error("ADMIN PDF Download Error:", err);
        res.status(500).send('Failed to generate full system PDF report due to a server error.');
    }
});


// Ensure AccountClosureRequest model is imported at the top
// const AccountClosureRequest = require('../models/AccountClosureRequest'); 

// ==========================================================
// X. ACCOUNT CLOSURE REQUESTS (Admin Panel)
// ==========================================================

// GET /admin/requests (रिक्वेस्ट लिस्ट दिखाने के लिए)
router.get('/requests', ensureAdminAuth, async (req, res) => {
    try {
        // केवल Pending और Approved/Rejected रिक्वेस्ट को दिखाएं
        const closureRequests = await AccountClosureRequest.find({ status: { $in: ['Pending', 'Approved', 'Rejected'] } })
            .sort({ requestedAt: 1 }); // पुरानी रिक्वेस्ट पहले

        res.render('adminClosureRequests', { 
            title: 'Account Closure Requests', 
            requests: closureRequests,
            message: req.session.message || null, 
            error: req.session.error || null 
        });

    } catch (error) {
        console.error("Admin Requests Error:", error);
        req.session.error = 'Failed to load account closure requests.';
        res.redirect('/admin/dashboard');
    }
});

// POST /admin/approve-closure/:requestId (रिक्वेस्ट अप्रूव करके अकाउंट डिलीट करने के लिए)
router.post('/approve-closure/:requestId', ensureAdminAuth, async (req, res) => {
    const requestId = req.params.requestId;
    
    try {
        const request = await AccountClosureRequest.findById(requestId);

        if (!request || request.status !== 'Pending') {
            req.session.error = 'Request not found or already processed.';
            return res.redirect('/admin/requests');
        }

        const userToClose = await User.findById(request.userId);
        
        // 🚨 FIX: Save required variables BEFORE critical checks/deletion
        let userEmail = null;
        let userName = request.userName; // Use name from request model (already saved)

        if (!userToClose) {
            // अगर यूजर पहले ही डिलीट हो चुका है
            request.status = 'Approved';
            await request.save();
            req.session.message = 'User account was already deleted. Request marked as Approved.';
            return res.redirect('/admin/requests');
        }

        // Get email from the live User object before any potential deletion/rejection
        userEmail = userToClose.email; 

        // 🚨 CRITICAL LOAN CHECK: अगर बैलेंस नेगेटिव है (मतलब लोन बकाया है) तो रिजेक्ट करें
        if (userToClose.balance < 0) {
            request.status = 'Rejected';
            await request.save();
            
            // 🚨 FIX 3: Send rejection email alert
            sendTransactionAlert(
                { email: userEmail, name: userName, balance: userToClose.balance }, // Pass user data
                'Account Closure Rejected', 
                0, 
                `Your closure request was REJECTED because you have a negative balance (₹ ${userToClose.balance.toFixed(2)} due). Please clear your dues first.`,
                'Nova Bank: Closure Request Rejected'
            );

            req.session.error = `Closure REJECTED: User ${userToClose.name} has a negative balance (₹ ${userToClose.balance.toFixed(2)} due).`;
            return res.redirect('/admin/requests');
        }
        
        // 1. फाइनल DELETION
        await User.deleteOne({ _id: request.userId });
        
        // 2. रिक्वेस्ट को Approved मार्क करें
        request.status = 'Approved';
        await request.save();
        
        // 🚨 FIX 4: Send approval/deletion email alert
        sendTransactionAlert(
            { email: userEmail, name: userName, balance: 0 }, // Pass user data for email
            'Account Closed', 
            0, 
            'Your Nova Bank account has been permanently closed as per your request. Thank you for banking with us.',
            'Nova Bank: Account Successfully Closed' 
        );
        
        req.session.message = `Account of ${request.userName} (A/C ${request.accountNumber}) successfully DELETED.`;
        res.redirect('/admin/requests');

    } catch (error) {
        console.error("Admin Approve Closure Error:", error);
        req.session.error = 'Account deletion failed due to a server error.';
        res.redirect('/admin/requests');
    }
});


module.exports = router;