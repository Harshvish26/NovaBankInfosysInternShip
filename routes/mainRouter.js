// --- File: mainRouter.js ---

const express = require('express');
const router = express.Router(); 

// Home Page (Assuming you have one)
router.get('/', (req, res) => {
    res.render('home', { title: 'Welcome to Nova Bank', session: req.session });
});

// Features Page (Public)
router.get('/features', (req, res) => {
    // Note: 'features' is the name of your EJS template file
    res.render('features', { title: 'Bank Features', session: req.session });
});

// Contact Us Page (Public)
router.get('/contact', (req, res) => {
    // Note: 'contact' is the name of your EJS template file
    res.render('contact', { title: 'Contact Us', session: req.session });
});

// User Login/Register routes (if not in userRouter) could also go here

module.exports = router;