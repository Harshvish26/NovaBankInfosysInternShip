const mongoose = require('mongoose');

const AccountClosureRequestSchema = new mongoose.Schema({
    // User ID: हमें पता चलता है कि किस यूजर का अकाउंट डिलीट करना है
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
    },
    // नाम और अकाउंट नंबर Admin के डैशबोर्ड पर दिखाने के लिए
    userName: {
        type: String,
        required: true
    },
    accountNumber: {
        type: String,
        required: true
    },
    // बैलेंस: Admin तुरंत देख सके कि यूजर पर कोई देनदारी तो नहीं
    userBalance: {
        type: Number,
        required: true
    },
    requestedAt: {
        type: Date,
        default: Date.now
    },
    status: {
        type: String,
        enum: ['Pending', 'Approved', 'Rejected'],
        default: 'Pending'
    }
});

module.exports = mongoose.model('AccountClosureRequest', AccountClosureRequestSchema);