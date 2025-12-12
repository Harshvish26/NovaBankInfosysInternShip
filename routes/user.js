const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs'); 
const nodemailer = require('nodemailer'); 
const { ensureAuth } = require('../middleware/authMiddleware');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const AccountClosureRequest = require('../models/AccountClosureRequest');
const PDFDocument = require('pdfkit');

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
// 10. DOWNLOAD REPORT (Updated for ACTUAL PDF DOWNLOAD)
// ==========================================================

router.get('/download-report', ensureAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);

        const allTxs = await Transaction.find({ $or: [{ fromAccount: user.accountNumber }, { toAccount: user.accountNumber }] })
            .sort({ createdAt: -1 });

        const doc = new PDFDocument({ 
            size: 'A4', 
            margins: { top: 50, bottom: 50, left: 50, right: 50 } 
        });

        const filename = `NovaBank_Statement_${user.accountNumber}_${new Date().toISOString().slice(0, 10)}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);

        // --- 1. Header and Summary ---
        doc.font('Helvetica-Bold').fontSize(22).fillColor('#1F2937').text('NOVA BANK ACCOUNT STATEMENT', { align: 'center' });
        doc.moveDown(0.2);
        doc.fontSize(10).fillColor('#6B7280').text(`Date Generated: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(1);
        doc.lineWidth(1).lineCap('butt').strokeColor('#D1DDDB').moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(1.5);

        // Summary
        doc.fontSize(16).fillColor('#3B82F6').text('Account Summary:', { underline: true });
        doc.moveDown(0.5);

        doc.fontSize(12).fillColor('#1F2937');
        doc.text('Account Holder:', 50, doc.y, { continued: true }).fillColor('#000000').text(` ${user.name}`);
        doc.moveDown(0.3);
        
        doc.fillColor('#1F2937').text('Account Number:', 50, doc.y, { continued: true }).fillColor('#000000').text(` ${user.accountNumber}`);
        doc.moveDown(0.3);

        doc.fillColor('#1F2937').text('City:', 50, doc.y, { continued: true }).fillColor('#000000').text(` ${user.city || 'N/A'}`);
        doc.moveDown(0.8);
        
        doc.fillColor('#1F2937').font('Helvetica-Bold').text('Current Balance:', 50, doc.y, { continued: true })
           .fillColor('#10B981').text(` ₹ ${user.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
        doc.moveDown(1.5);
        doc.lineWidth(0.5).strokeColor('#E5E7EB').moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(1.5);


        // --- 2. Transaction Details Table ---
        doc.fontSize(16).fillColor('#3B82F6').text('Recent Transactions:', { underline: true });
        doc.moveDown(0.5);

        // Define Column Structure with fixed X-positions
        // 🚨 IMPORTANT: These X values MUST be used for both Header and Data
        const COLUMNS = [
            { id: 'Date', x: 50, width: 60, align: 'left' },      // Starts at 50
            { id: 'Type', x: 115, width: 60, align: 'left' },     // Starts at 115
            { id: 'Flow', x: 190, width: 40, align: 'left' },     // Starts at 190
            { id: 'Amount', x: 260, width: 100, align: 'right' }, // Starts at 260, Aligned Right
            { id: 'Details', x: 380, width: 170, align: 'left' }  // Starts at 380
        ];
        
        // Function to draw the header row
        const drawHeader = () => {
            let headerY = doc.y;
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#4B5563');
            COLUMNS.forEach(col => {
                doc.text(col.id.toUpperCase(), col.x, headerY, { width: col.width, align: col.align });
            });
            doc.moveDown(0.5);
            doc.strokeColor('#D1D5DB').lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            doc.moveDown(0.5);
        };
        
        drawHeader(); // Initial header
        
        // Draw Table Rows
        doc.font('Helvetica').fontSize(9).fillColor('#1F2937');
        
        allTxs.forEach(tx => {
            // Check for pagination before drawing the row
            if (doc.y + 20 > doc.page.height - doc.page.margins.bottom) {
                doc.addPage();
                drawHeader(); // New header on the new page
            }
            
            const isDebit = tx.fromAccount === user.accountNumber && tx.type !== 'deposit';
            const flowColor = isDebit ? '#EF4444' : '#10B981'; 

            const data = {
                Date: tx.createdAt.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
                Type: tx.type.toUpperCase(),
                Flow: isDebit ? 'DEBIT' : 'CREDIT',
                Amount: (isDebit ? '-' : '+') + tx.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
                Details: tx.description || (isDebit ? `To A/C: ${tx.toAccount}` : `From A/C: ${tx.fromAccount}`),
            };
            
            let rowY = doc.y; // Capture the starting Y position for this row
            
            // Draw all columns on the same rowY coordinate, using explicit X and Width
            
            // 1. Date
            doc.text(data.Date, COLUMNS[0].x, rowY, { width: COLUMNS[0].width, align: COLUMNS[0].align });

            // 2. Type
            doc.text(data.Type, COLUMNS[1].x, rowY, { width: COLUMNS[1].width, align: COLUMNS[1].align });
            
            // 3. Flow (Colored)
            doc.fillColor(flowColor).text(data.Flow, COLUMNS[2].x, rowY, { width: COLUMNS[2].width, align: COLUMNS[2].align });
            
            // 4. Amount (Aligned Right)
            doc.fillColor(flowColor).text(data.Amount, COLUMNS[3].x, rowY, { width: COLUMNS[3].width, align: COLUMNS[3].align });

            // 5. Details (Uncolored)
            doc.fillColor('#1F2937').text(data.Details, COLUMNS[4].x, rowY, { width: COLUMNS[4].width, align: COLUMNS[4].align });

            doc.moveDown(1); // Move to the next line for the next transaction
        });
        
        // Finalize PDF
        doc.end();

    } catch (err) {
        console.error("PDF Download Error:", err);
        res.status(500).send('Failed to generate PDF report due to a server error.');
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
// 13. CLOSE ACCOUNT (Permanent Deactivation - UPDATED FOR ADMIN APPROVAL)
// ==========================================================

router.post('/close-account', ensureAuth, async (req, res) => {
    try {
        const { pin } = req.body;
        
        // 🚨 Make sure these models are imported at the top of userRouter.js
        // const AccountClosureRequest = require('../models/AccountClosureRequest');
        // const User = require('../models/User');
        
        const user = await User.findById(req.session.userId);
        
        // PIN Verification is crucial for account closure
        const isPinValid = await bcrypt.compare(pin, user.pinHash);
        if (!isPinValid) {
            return res.redirect('/user/dashboard?error=PIN verification failed for account closure.');
        }

        // 1. Check for existing pending request
        const existingRequest = await AccountClosureRequest.findOne({ userId: user._id, status: 'Pending' });
        if (existingRequest) {
             return res.redirect('/user/dashboard?message=Your account closure request is already pending admin review.');
        }

        // 2. Create the request entry for admin panel
        await AccountClosureRequest.create({
            userId: user._id,
            accountNumber: user.accountNumber,
            userName: user.name,
            userBalance: user.balance // Capture balance for admin review
        });

        // 3. SEND EMAIL ALERT (Using await to ensure the process starts)
        await sendTransactionAlert( // 🟢 FIX: Added 'await' here
            user, 
            'Account Closure Request', 
            0, // Amount is 0 for non-monetary alert
            'Your request for permanent account closure has been successfully submitted and is awaiting Admin review. Please check your spam folder if you do not see the email.',
            'Nova Bank: Account Closure Request Received' // Custom Subject
        );
        
        // 4. Log user out and give a confirmation message
        req.session.destroy(() => {
            res.redirect('/?message=Your account closure request has been successfully submitted for Admin approval. We will notify you once reviewed.');
        });
        
    } catch (err) {
        console.error("Close Account Request Error:", err);
        res.redirect('/user/dashboard?error=Failed to submit account closure request.');
    }
});

// ==========================================================
// 14. MOBILE/DTH/BILL PAYMENTS (Combined Logic)
// ==========================================================

router.get('/pay-bills', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    res.render('userBillPayment', { user, error: req.query.error || null, message: req.query.message || null });
});

router.post('/utility-payment', ensureAuth, async (req, res) => {
    try {
        const { amount, pin, paymentType, billerId } = req.body; 
        const user = await User.findById(req.session.userId);

        // 1. PIN Verification
        const isPinValid = await bcrypt.compare(pin, user.pinHash);
        if (!isPinValid) {
            return res.redirect(`/user/pay-bills?error=PIN verification failed for ${paymentType}.`);
        }
        
        const amt = Number(amount);
        // ... (Validation checks for amt > 0) ...
        if (user.balance < amt) {
            return res.redirect(`/user/pay-bills?error=Insufficient balance for ${paymentType}.`);
        }

        // 🚨 CARD SPENDING LIMIT CHECK (Unchanged)
        const cardLimit = user.cardLimit || 50000; 
        if (user.isVirtualCardActive === false) {
            return res.redirect(`/user/pay-bills?error=Error: Virtual Card is currently deactivated/frozen. Activate it to pay.`);
        }
        if (amt > cardLimit) {
            return res.redirect(`/user/pay-bills?error=Transaction failed! Amount (₹${amt.toFixed(2)}) exceeds your set daily card limit (₹${cardLimit.toFixed(2)}).`);
        }
        

        // -------------------------------------------------------------
        // 🟢 FIX 1: Missing Transaction Logging and Email Alert Added Back
        // -------------------------------------------------------------
        
        // 2. Perform Payment (Debit)
        user.balance -= amt;
        await user.save();
        
        // Log Transaction: Type is 'payment'
        await Transaction.create({ 
            fromAccount: user.accountNumber, 
            toAccount: billerId, 
            amount: amt, 
            type: 'payment', // Important: type is 'payment'
            description: `${paymentType} to ${billerId}` // Log description for clarity
        });
        
        // Send Email Alert
        sendTransactionAlert(user, paymentType, amt, `Payment successful to ${billerId}.`);
        
        // -------------------------------------------------------------
        
        res.redirect(`/user/dashboard?message=${paymentType} of ₹${amt.toFixed(2)} successful!`);
    } catch (err) {
        console.error("Utility Payment Error:", err);
        res.redirect('/user/pay-bills?error=Payment failed due to server error.');

    }
});


// ==========================================================
// 15. VIRTUAL DEBIT CARD MANAGEMENT
// ==========================================================

router.get('/virtual-card', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    
    // Simulate card details (uses fields from the User model like isVirtualCardActive and cardLimit)
    const cardDetails = {
        // Masking the account number to simulate a card number display
        cardNumber: user.accountNumber.slice(0, 4) + ' **** **** ' + user.accountNumber.slice(-4),
        expiry: '12/28', // Fixed/Simulated expiry
        cvv: user.accountNumber.slice(-3), // Simulated CVV based on A/C number
        // Check if the status field exists on the user object, otherwise default to true
        isActive: user.isVirtualCardActive !== undefined ? user.isVirtualCardActive : true,
        limit: user.cardLimit || 50000 // Default limit if not set in DB
    };
    
    // Renders the userVirtualCard.ejs template and passes the 'card' object
    res.render('userVirtualCard', { 
        user, 
        card: cardDetails, 
        error: req.query.error || null, 
        message: req.query.message || null 
    });
});

// Activate/Deactivate Card
router.post('/toggle-card', ensureAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        
        // Ensure the field exists in your User model for persistence
        if (user.isVirtualCardActive === undefined) {
             user.isVirtualCardActive = true; // Initialize if first time
        }
        
        user.isVirtualCardActive = !user.isVirtualCardActive;
        await user.save();
        
        const status = user.isVirtualCardActive ? 'Activated' : 'Deactivated';
        res.redirect(`/user/virtual-card?message=Virtual card successfully ${status}.`);

    } catch (err) {
        console.error("Toggle Card Error:", err);
        res.redirect('/user/virtual-card?error=Failed to toggle card status.');
    }
});


// ==========================================================
// 16. SET CARD LIMIT (New Feature)
// ==========================================================

router.post('/set-card-limit', ensureAuth, async (req, res) => {
    try {
        const { newLimit, pin } = req.body;
        const user = await User.findById(req.session.userId);
        
        // 1. PIN Verification
        const isPinValid = await bcrypt.compare(pin, user.pinHash);
        if (!isPinValid) {
            return res.redirect('/user/virtual-card?error=PIN verification failed. Limit not updated.');
        }
        
        const limit = Number(newLimit);
        if (isNaN(limit) || limit < 0) {
            return res.redirect('/user/virtual-card?error=Invalid limit amount.');
        }

        // 2. Update Card Limit (This field needs to be added to your User model)
        user.cardLimit = limit;
        await user.save();
        
        res.redirect(`/user/virtual-card?message=Virtual card limit set to ₹${limit.toLocaleString('en-IN')}.`);

    } catch (err) {
        console.error("Set Card Limit Error:", err);
        res.redirect('/user/virtual-card?error=Failed to set card limit.');
    }
});


// ==========================================================
// 13. UTILITY OPTIONS PAGE (New intermediate page)
// ==========================================================

router.get('/utility-options', ensureAuth, async (req, res) => {
    // We don't need much data here, just rendering the options page
    res.render('userBillOptions', { 
        user: req.user, // Assuming you have user object attached to req from authMiddleware
        title: 'Select Utility', 
        error: req.query.error || null, 
        message: req.query.message || null 
    });
});



router.get('/mobile-offers', ensureAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    const { operator, number } = req.query; 
    
    // --- UPDATED: 15 SIMULATED PLANS ---
    const offers = [
        // Daily Data Plans (Short to Long Term)
        { id: 'O1', amount: 149, details: 'Unlimited Calls + 1GB/Day', validity: '20 Days', category: 'Data/Calls' },
        { id: 'O2', amount: 239, details: 'Unlimited Calls + 1.5GB/Day', validity: '28 Days', category: 'Data/Calls' },
        { id: 'O3', amount: 299, details: 'Unlimited Calls + 2GB/Day', validity: '28 Days', category: 'Data/Calls' },
        { id: 'O4', amount: 479, details: 'Unlimited Calls + 1.5GB/Day', validity: '56 Days', category: 'Data/Calls' },
        { id: 'O5', amount: 666, details: 'Unlimited Calls + 1.5GB/Day', validity: '84 Days', category: 'Data/Calls' },
        
        // High Data / Yearly Plans
        { id: 'O6', amount: 849, details: 'Unlimited Calls + 3GB/Day', validity: '84 Days', category: 'High Data' },
        { id: 'O7', amount: 1449, details: 'Unlimited Calls + 2GB/Day', validity: '180 Days', category: 'Long Term' },
        { id: 'O8', amount: 2999, details: 'Unlimited Calls + 2.5GB/Day', validity: '365 Days', category: 'Yearly' },
        { id: 'O9', amount: 3599, details: 'Unlimited Calls + 3GB/Day', validity: '365 Days', category: 'Yearly' },

        // Voice/Talktime Only
        { id: 'O10', amount: 99, details: '100 MB Data + ₹99 Talktime', validity: '28 Days', category: 'Voice' },
        { id: 'O11', amount: 155, details: 'Unlimited Calls (FUP) + 1GB Total', validity: '24 Days', category: 'Voice' },

        // Data Add-ons / Boosters
        { id: 'O12', amount: 25, details: 'Data Booster Pack (2GB)', validity: 'Existing Plan' },
        { id: 'O13', amount: 61, details: 'Data Booster Pack (6GB)', validity: 'Existing Plan' },
        
        // Low Cost / Entry Plans
        { id: 'O14', amount: 19, details: 'Unlimited Calls + 100MB Total', validity: '2 Days', category: 'Budget' },
        { id: 'O15', amount: 15, details: 'Emergency Talktime Loan', validity: 'Immediate' , category: 'Emergency'},
    ];

    res.render('userMobileOffers', { 
        user, 
        offers, 
        operator: operator || 'Jio/Airtel', // Default operator for display
        number: number || '73XXXXXXXX', // Default number for display
        error: req.query.error || null ,
        message: req.query.message || null
    });
});


router.get('/features', (req, res) => {
    res.render('features', { title: 'Bank Features', session: req.session });
});

router.get('/contact', (req, res) => {
    res.render('contact', { title: 'Contact Us', session: req.session });
});





module.exports = router;