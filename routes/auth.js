require('dotenv').config();
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const nodemailer = require("nodemailer");

// Helper to generate 12-digit account number
function generateAccountNumber() {
  let num = "";
  for (let i = 0; i < 12; i++) num += Math.floor(Math.random() * 10);
  return num;
}

// Helper to generate 6-digit OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000); // Generates 100000 to 999999
}

// nodemailer transporter (uses .env)
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

// ==========================================================
// 1. REGISTRATION
// ==========================================================
router.get("/register", (req, res) => res.render("register", { error: null }));

router.post("/register", async (req, res) => {
  try {
    const { name, email, mobile, age, aadhar, city, pin } = req.body;
    if (!name || !email || !pin)
      return res.render("register", {
        error: "Please fill required fields (name, email, pin)",
      });

    if (pin.length < 3)
      return res.render("register", { error: "PIN too short" });

    const exists = await User.findOne({ email });
    if (exists)
      return res.render("register", { error: "Email already registered" });

    const pinHash = await bcrypt.hash(pin, 10);
    let accountNumber = generateAccountNumber();
    while (await User.findOne({ accountNumber }))
      accountNumber = generateAccountNumber();

    const user = new User({
      name, email, mobile, age, aadhar, city, pinHash, accountNumber,
    });
    await user.save();

    // send email with account number
    if (transporter) {
      const mailOptions = {
        from: `${process.env.FROM_NAME || "Nova Bank"} <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Your Nova Bank Account Number",
        text: `Hello ${name},\n\nYour Nova Bank account has been created.\nAccount Number: ${accountNumber}\n\nKeep it safe.`,
      };
      transporter.sendMail(mailOptions, (err, info) => {
        if (err) { console.error("❌ Mail Error Details:", err); } 
        else { console.log("📨 Account Email sent:", info.response); }
      });
    } else { console.log("Email not sent - transporter not configured."); }

    // Redirect to login
    res.redirect("/login");
  } catch (err) {
    console.error(err);
    res.render("register", { error: "Something went wrong" });
  }
});

// ==========================================================
// 2. LOGIN (Step 1: Credentials Check -> Redirect to OTP)
// ==========================================================
router.get("/login", (req, res) => res.render("login", { error: null }));

router.post("/login", async (req, res) => {
    try {
        // 💡 Now requires email, pin, AND accountNumber
        const { email, pin, accountNumber } = req.body;
        
        // 1. Find user by email AND account number
        const user = await User.findOne({ email, accountNumber });
        
        if (!user) return res.render("login", { error: "Invalid credentials or account number." });
        
        // 2. Verify PIN
        const ok = await bcrypt.compare(pin, user.pinHash);
        if (!ok) return res.render("login", { error: "Invalid PIN." });
        
        // 3. Generate OTP and store temporary session data
        const otp = generateOTP();
        req.session.tempOTP = otp;
        req.session.tempUserId = user._id; // Store ID temporarily
        
        // 4. Send OTP via email
        if (transporter) {
            const mailOptions = {
                from: `${process.env.FROM_NAME || "Nova Bank"} <${process.env.EMAIL_USER}>`,
                to: user.email,
                subject: "OTP for Nova Bank Login",
                text: `Hello ${user.name},\n\nYour One-Time Password (OTP) for login is: ${otp}\n\nThis OTP is valid for a short time. Do not share it.`,
            };
            transporter.sendMail(mailOptions, (err, info) => {
                if (err) { console.error("❌ OTP Mail Error:", err); } 
                else { console.log("📨 OTP Email sent:", info.response); }
            });
        } else { console.log(`OTP not sent. Code: ${otp}`); }

        // 5. Redirect to OTP verification page
        req.session.save(err => {
            if (err) {
                console.error("❌ Login Session Save Error:", err);
                return res.render("login", { error: "Login failed (Session error)." });
            }
            res.redirect("/otp");
        });

    } catch (err) {
        console.error(err);
        res.render("login", { error: "Something went wrong" });
    }
});


// ==========================================================
// 3. OTP VERIFICATION
// ==========================================================
router.get("/otp", (req, res) => {
    // Ensure temporary data exists before rendering OTP page
    if (!req.session.tempOTP) {
        return res.redirect("/login");
    }
    res.render("otp", { error: null });
});

router.post("/otp", async (req, res) => {
    try {
        const { otp } = req.body;
        
        // 1. Check if OTP is stored and matches
        if (!req.session.tempOTP || String(req.session.tempOTP) !== otp) {
            return res.render("otp", { error: "Invalid or expired OTP." });
        }

        // 2. OTP is valid. Finalize login.
        const user = await User.findById(req.session.tempUserId);
        if (!user) return res.redirect("/logout"); // Should not happen

        // Transfer temporary credentials to permanent session variables
        req.session.userId = user._id;
        req.session.userName = user.name;
        req.session.accountNumber = user.accountNumber;
        req.session.city = user.city;

        // Clear temporary data
        delete req.session.tempOTP;
        delete req.session.tempUserId;

        // 3. Redirect to dashboard
        req.session.save(err => {
            if (err) {
                console.error("❌ OTP Final Save Error:", err);
                return res.render("otp", { error: "Verification failed (Session error)." });
            }
            res.redirect("/user/dashboard");
        });

    } catch (err) {
        console.error(err);
        res.render("otp", { error: "Something went wrong during verification." });
    }
});


// ==========================================================
// 4. LOGOUT
// ==========================================================
router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;