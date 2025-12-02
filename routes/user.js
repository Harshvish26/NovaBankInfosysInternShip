const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs'); 
const nodemailer = require('nodemailer'); 
const { ensureAuth } = require('../middleware/authMiddleware');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// --- Email Transporter Configuration (Used for alerts/OTP) ---
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

// Helper to send transaction email alert
async function sendTransactionAlert(user, txType, amount, details, subjectOverride = null) {
    if (!transporter) return console.log("Email Alert skipped: Transporter not configured.");

    const subject = subjectOverride || `Nova Bank Alert: Successful ${txType} of ₹${amount.toFixed(2)}`;
    const body = `Dear ${user.name},\n\nYour recent transaction was successful.\n\nType: ${txType}\nAmount: ₹${amount.toFixed(2)}\nDetails: ${details}\n\nYour new balance is ₹${user.balance.toFixed(2)}.\n\nThank you for banking with Nova Bank.`;

    const mailOptions = {
        from: `${process.env.FROM_NAME || "Nova Bank Alerts"} <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: subject,
        text: body,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📨 Alert sent: ${txType} to ${user.email}`);
    } catch (err) {
        console.error(`❌ Email Alert Failed for ${txType}:`, err);
    }
}

// Helper to generate 6-digit OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000); 
}

// ==========================================================
// 1. DASHBOARD OVERVIEW
// ==========================================================

router.get('/dashboard', ensureAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);
  // Load only 5 latest for mini statement display on dashboard
  const txs = await Transaction.find({
    $or: [{ fromAccount: user.accountNumber }, { toAccount: user.accountNumber }]
  }).sort({ createdAt: -1 }).limit(5);

  res.render('userDashboard', { user, txs, error: req.query.error || null, message: req.query.message || null });
});


// ==========================================================
// 2. DEPOSIT
// ==========================================================

router.get('/deposit', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    res.render('userDeposit', { user, error: null });
});

router.post('/deposit', ensureAuth, async (req, res) => {
  try {
    const { amount, pin } = req.body; 
    const user = await User.findById(req.session.userId);

    // 1. PIN Verification
    const isPinValid = await bcrypt.compare(pin, user.pinHash);
    if (!isPinValid) {
      return res.render('userDeposit', { user, error: 'PIN verification failed.' });
    }

    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.render('userDeposit', { user, error: 'Invalid deposit amount.' });
    }

    // Perform deposit
    user.balance += amt;
    await user.save();
    await Transaction.create({ fromAccount: 'bank', toAccount: user.accountNumber, amount: amt, type: 'deposit' });
    
    // Email Alert
    sendTransactionAlert(user, 'Deposit', amt, `Deposit from external source.`);

    res.redirect('/user/dashboard?message=Deposit successful!');
  } catch (err) {
    console.error("Deposit Error:", err);
    res.redirect('/user/dashboard?error=Deposit failed due to server error.');
  }
});

// ==========================================================
// 3. WITHDRAW
// ==========================================================

router.get('/withdraw', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    res.render('userWithdraw', { user, error: null });
});

router.post('/withdraw', ensureAuth, async (req, res) => {
  try {
    const { amount, pin } = req.body; 
    const user = await User.findById(req.session.userId);

    // 1. PIN Verification
    const isPinValid = await bcrypt.compare(pin, user.pinHash);
    if (!isPinValid) {
      return res.render('userWithdraw', { user, error: 'PIN verification failed.' });
    }

    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.render('userWithdraw', { user, error: 'Invalid withdrawal amount.' });
    }
    if (user.balance < amt) {
      return res.render('userWithdraw', { user, error: 'Insufficient balance.' });
    }

    // Perform withdraw
    user.balance -= amt;
    await user.save();
    await Transaction.create({ fromAccount: user.accountNumber, toAccount: 'cash', amount: amt, type: 'withdraw' });
    
    // Email Alert
    sendTransactionAlert(user, 'Withdrawal', amt, `Cash withdrawal.`);

    res.redirect('/user/dashboard?message=Withdrawal successful!');
  } catch (err) {
    console.error("Withdraw Error:", err);
    res.redirect('/user/dashboard?error=Withdrawal failed due to server error.');
  }
});

// ==========================================================
// 4. FUND TRANSFER
// ==========================================================

router.get('/transfer', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    res.render('userTransfer', { user, error: null });
});

router.post('/transfer', ensureAuth, async (req, res) => {
  try {
    const { toAccount, amount, pin } = req.body;
    const from = await User.findById(req.session.userId);

    // 1. PIN Verification
    const isPinValid = await bcrypt.compare(pin, from.pinHash);
    if (!isPinValid) {
      return res.render('userTransfer', { user: from, error: 'PIN verification failed.' });
    }

    const to = await User.findOne({ accountNumber: toAccount });
    const amt = Number(amount);

    if (!to) {
      return res.render('userTransfer', { user: from, error: 'Destination account not found.' });
    }
    if (from.accountNumber === to.accountNumber) {
        return res.render('userTransfer', { user: from, error: 'Cannot transfer money to the same account.' });
    }
    if (isNaN(amt) || amt <= 0) {
      return res.render('userTransfer', { user: from, error: 'Invalid transfer amount.' });
    }
    if (from.balance < amt) {
      return res.render('userTransfer', { user: from, error: 'Insufficient balance for transfer.' });
    }


    // Perform transfer
    from.balance -= amt;
    to.balance += amt;
    await from.save();
    await to.save();
    const tx = await Transaction.create({ fromAccount: from.accountNumber, toAccount: to.accountNumber, amount: amt, type: 'transfer' });
    
    // Email Alerts
    sendTransactionAlert(from, 'Transfer (Debit)', amt, `Sent to A/C: ${to.accountNumber} (${to.name})`);
    sendTransactionAlert(to, 'Transfer (Credit)', amt, `Received from A/C: ${from.accountNumber} (${from.name})`);

    res.redirect('/user/dashboard?message=Transfer successful!');
  } catch (err) {
    console.error("Transfer Error:", err);
    res.redirect('/user/dashboard?error=Transfer failed due to server error.');
  }
});

// ==========================================================
// 5. VIEW FULL TRANSACTION HISTORY
// ==========================================================

router.get('/history', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    // Load ALL transactions for full history
    const txs = await Transaction.find({
        $or: [{ fromAccount: user.accountNumber }, { toAccount: user.accountNumber }]
    }).sort({ createdAt: -1 });

    res.render('userHistory', { user, txs, error: null });
});


// ==========================================================
// 6. CHANGE PIN (Multi-Step Logic)
// ==========================================================

router.get('/change-pin', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    res.render('userChangePin', { user, error: null, step: 1 });
});

router.post('/change-pin-otp', ensureAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        
        // Generate OTP and store temporary data
        const otp = generateOTP();
        req.session.pinChangeOTP = otp;
        
        // Send OTP via email
        if (transporter) {
            const mailOptions = {
                from: `${process.env.FROM_NAME || "Nova Bank"} <${process.env.EMAIL_USER}>`,
                to: user.email,
                subject: "OTP for PIN Change Request",
                text: `Dear ${user.name},\n\nYour OTP to change your banking PIN is: ${otp}\n\nThis OTP is valid for a short time.`,
            };
            transporter.sendMail(mailOptions, (err, info) => {
                if (err) { console.error("❌ PIN OTP Mail Error:", err); } 
                else { console.log("📨 PIN OTP sent:", info.response); }
            });
        }
        
        req.session.save(() => {
            res.render('userChangePin', { user, error: null, step: 2 });
        });
    } catch (err) {
        console.error("PIN Change OTP Error:", err);
        res.redirect('/user/dashboard?error=PIN change request failed.');
    }
});

router.post('/set-new-pin', ensureAuth, async (req, res) => {
    try {
        const { otp, newPin } = req.body;
        const user = await User.findById(req.session.userId);

        // 1. Verify OTP
        if (!req.session.pinChangeOTP || String(req.session.pinChangeOTP) !== otp) {
            return res.render('userChangePin', { user, error: 'Invalid OTP.', step: 2 });
        }
        
        // 2. Validate New PIN
        if (!newPin || newPin.length < 3) {
            return res.render('userChangePin', { user, error: 'New PIN is too short.', step: 2 });
        }

        // 3. Update PIN
        user.pinHash = await bcrypt.hash(newPin, 10);
        await user.save();

        // 4. Clear temporary data
        delete req.session.pinChangeOTP;

        res.redirect('/user/dashboard?message=PIN successfully updated!');
    } catch (err) {
        console.error("Set New PIN Error:", err);
        res.redirect('/user/dashboard?error=Failed to set new PIN.');
    }
});


// ==========================================================
// 7. PROFILE UPDATE
// ==========================================================

router.get('/profile', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    res.render('userProfile', { user, error: null, message: req.query.message || null });
});

router.post('/profile', ensureAuth, async (req, res) => {
    try {
        const { mobile, city } = req.body;
        const user = await User.findById(req.session.userId);

        if (!mobile || !city) {
            return res.render('userProfile', { user, error: 'Mobile and City cannot be empty.' });
        }
        
        user.mobile = mobile;
        user.city = city;
        await user.save();
        
        res.redirect('/user/profile?message=Profile updated successfully!');

    } catch (err) {
        console.error("Profile Update Error:", err);
        res.render('userProfile', { user, error: 'Failed to update profile.', message: null });
    }
});


// ==========================================================
// 8. LOAN REQUEST (Updated to Save to Global Store)
// ==========================================================

router.get('/loan-request', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    // FIX: Ensure error/message are passed safely
    res.render('userLoanRequest', { user, error: req.query.error || null, message: req.query.message || null });
});

router.post('/loan-request', ensureAuth, async (req, res) => {
    try {
        const { loanAmount, loanReason } = req.body;
        const user = await User.findById(req.session.userId);

        const amt = Number(loanAmount);
        if (isNaN(amt) || amt <= 0) {
            return res.render('userLoanRequest', { user, error: 'Invalid loan amount.', message: null });
        }

        // --- NEW: SAVE LOAN REQUEST TO GLOBAL STORE FOR ADMIN ---
        const loanId = `L-${Date.now()}`;
        global.loanRequests.push({
            id: loanId,
            userId: user._id.toString(),
            name: user.name,
            accountNumber: user.accountNumber,
            amount: amt,
            reason: loanReason,
            status: 'Pending',
            date: new Date()
        });

        console.log(`🏦 New Loan Request Saved (${loanId}) for A/C ${user.accountNumber}`);
        sendTransactionAlert(user, 'Loan Request', amt, `Your loan request (ID: ${loanId}) has been received and is under review.`, `Nova Bank: Loan Request Received`);

        res.redirect(`/user/dashboard?message=Loan request for ₹${amt.toLocaleString('en-IN')} submitted successfully! Check email for details.`);

    } catch (err) {
        console.error("Loan Request Error:", err);
        res.redirect('/user/dashboard?error=Loan request failed due to server error.');
    }
});


// ==========================================================
// 9. CALCULATE INTEREST
// ==========================================================

router.get('/calculate-interest', ensureAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        
        // --- SIMULATION ---
        const annualRate = 4.0; // Simulated Annual Interest Rate (4%)
        const monthlyRate = annualRate / 12 / 100;
        const estimatedInterest = user.balance * monthlyRate;

        res.render('userInterestCalc', { 
            user, 
            currentBalance: user.balance, 
            rate: annualRate.toFixed(2), 
            estimatedInterest,
            error: null // FIX: Ensure error is passed as null
        });
    } catch (err) {
        console.error("Calculate Interest Error:", err);
        res.redirect('/user/dashboard?error=Failed to calculate interest.');
    }
});


// ==========================================================
// 10. DOWNLOAD REPORT (Updated for inline email content)
// ==========================================================

router.get('/download-report', ensureAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);

        // 1. Fetch ALL transactions
        const allTxs = await Transaction.find({ $or: [{ fromAccount: user.accountNumber }, { toAccount: user.accountNumber }] })
            .sort({ createdAt: -1 });

        // 2. Generate a formatted report body (Text/CSV style for email)
        let txRows = allTxs.map(tx => {
            const date = tx.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            const type = tx.fromAccount === user.accountNumber ? 'DEBIT' : 'CREDIT';
            const details = tx.fromAccount === user.accountNumber ? `To: ${tx.toAccount}` : `From: ${tx.fromAccount}`;
            const amount = tx.amount.toFixed(2);
            // Ensure padding handles varying lengths
            return `${date.padEnd(25)} | ${type.padEnd(7)} | ₹${amount.padStart(10)} | ${details}`; 
        }).join('\n');

        let reportBody = `
Dear ${user.name},

Your comprehensive account statement report has been generated.

--- ACCOUNT SUMMARY ---
Account Holder: ${user.name}
Account Number: ${user.accountNumber}
Current Balance: ₹ ${user.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
Report Generated On: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

--- TRANSACTION DETAILS ---
Date/Time                              Type             Amount               Details
-------------------------------------------------------------------------------------------
${txRows}                  
-------------------------------------------------------------------------------------------

Thank you for banking with Nova Bank.
        `;

        // 3. Send Email Alert with report content in the body
        const mailOptions = {
            from: `${process.env.FROM_NAME || "Nova Bank Statements"} <${process.env.EMAIL_USER}>`,
            to: user.email,
            subject: `Your Account Statement Report: A/C ${user.accountNumber}`,
            text: reportBody,
        };

        if (transporter) {
            await transporter.sendMail(mailOptions);
            console.log(`📨 Full statement sent to ${user.email}`);
        }

        // Redirect with message to confirm email sent
        res.redirect('/user/dashboard?message=Account statement report sent to your registered email.');

    } catch (err) {
        console.error("Download Report Error:", err);
        res.redirect('/user/dashboard?error=Failed to generate and send report.');
    }
});


// ==========================================================
// 11. HELP & SUPPORT (Chat)
// ==========================================================

router.get('/chat', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);

    // Initialize chat history in session if it doesn't exist
    if (!req.session.chatHistory) {
        req.session.chatHistory = [{ role: 'admin', text: 'Welcome to Nova Bank Support. How may I assist you today?' }];
    }
    
    res.render('userChat', { user, history: req.session.chatHistory });
});

router.post('/chat', ensureAuth, async (req, res) => {
    const { message } = req.body;
    
    if (!message || message.trim() === '') return res.redirect('/user/chat');

    // Add user message to history
    req.session.chatHistory.push({ role: 'user', text: message });
    
    // --- SIMULATION: Admin Response Delay ---
    await new Promise(resolve => setTimeout(resolve, 1500)); 

    // --- SIMULATION: Simple AI/Admin Auto-Reply ---
    const adminReply = `Thank you for your message: "${message.substring(0, 30)}...". Our Nova Assistant has logged your query and an admin will respond shortly. Please wait.`;
    
    req.session.chatHistory.push({ role: 'admin', text: adminReply });

    req.session.save(() => {
        res.redirect('/user/chat');
    });
});


// ==========================================================
// 12. FREEZE ACCOUNT
// ==========================================================

router.get('/freeze-account', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    res.render('userFreezeAccount', { user, error: null });
});

router.post('/freeze-account', ensureAuth, async (req, res) => {
    try {
        const { pin } = req.body;
        const user = await User.findById(req.session.userId);
        
        // PIN Verification
        const isPinValid = await bcrypt.compare(pin, user.pinHash);
        if (!isPinValid) {
            return res.render('userFreezeAccount', { user, error: 'PIN verification failed. Account not frozen.' });
        }

        // --- SIMULATION: Freeze Logic --- 
        console.log(`🚨 ACCOUNT FROZEN: User ${user.accountNumber} has been temporarily locked.`);
        
        // Log user out for security
        req.session.destroy(() => {
            res.redirect('/?error=Your account has been successfully frozen due to security concerns. Please contact support.');
        });
    } catch (err) {
        console.error("Freeze Account Error:", err);
        res.redirect('/user/dashboard?error=Freeze operation failed due to server error.');
    }
});


// ==========================================================
// 13. CLOSE ACCOUNT (Permanent Deactivation)
// ==========================================================

router.post('/close-account', ensureAuth, async (req, res) => {
    try {
        const { pin } = req.body;
        const user = await User.findById(req.session.userId);
        
        // PIN Verification is crucial for account closure
        const isPinValid = await bcrypt.compare(pin, user.pinHash);
        if (!isPinValid) {
            return res.redirect('/user/dashboard?error=PIN verification failed for account closure.');
        }

        // --- DEMO FEATURE --- 
        await User.deleteOne({ _id: user._id }); 
        
        // Log user out
        req.session.destroy(() => {
            res.redirect('/?message=Your Nova Bank account has been successfully closed.');
        });
    } catch (err) {
        console.error("Close Account Error:", err);
        res.redirect('/user/dashboard?error=Account closure failed.');
    }
});


module.exports = router;