app.get('/', (req, res) => {
  res.send('✅ Support Message Tracker backend is running successfully!');
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const app = express();

app.use(cors());
app.use(express.json());

// In-memory storage
const conversations = new Map();

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    WARNING_THRESHOLD: (process.env.WARNING_MINUTES || 5) * 60 * 1000,
    CRITICAL_THRESHOLD: (process.env.CRITICAL_MINUTES || 15) * 60 * 1000,
    EMAIL_ALERTS: process.env.EMAIL_ALERTS_ENABLED !== 'false',
    EMAIL_FROM: process.env.EMAIL_FROM || 'alerts@justinsuranceco.com',
    EMAIL_TO: process.env.EMAIL_TO ? process.env.EMAIL_TO.split(',') : ['support@justinsurance.com'],
    SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
    SMTP_PORT: parseInt(process.env.SMTP_PORT) || 587,
    SMTP_SECURE: process.env.SMTP_SECURE === 'true' || false,
    SMTP_USER: process.env.SMTP_USER || 'support@yourinsurancelicense.com',
    SMTP_PASS: process.env.SMTP_PASS || 'Telesales123$',
    
    // JustInsurance specific settings
    ASSIGNED_USER_FILTER: 'Support Team', // Only track "Support Team" conversations
    
    // Business Hours (EST/EDT timezone)
    BUSINESS_HOURS: {
        monday: { start: 8, end: 22 },
        tuesday: { start: 8, end: 22 },
        wednesday: { start: 8, end: 22 },
        thursday: { start: 8, end: 22 },
        friday: { start: 8, end: 22 },
        saturday: { start: 8, end: 18 },
        sunday: { start: 8, end: 18 }
    },
    TIMEZONE: 'America/New_York'
};

// Email transporter
let emailTransporter = null;
if (CONFIG.EMAIL_ALERTS) {
    try {
        emailTransporter = nodemailer.createTransport({
            host: CONFIG.SMTP_HOST,
            port: CONFIG.SMTP_PORT,
            secure: CONFIG.SMTP_SECURE,
            auth: {
                user: CONFIG.SMTP_USER,
                pass: CONFIG.SMTP_PASS
            }
        });
        console.log('✅ Email transporter configured');
    } catch (error) {
        console.error('❌ Error configuring email:', error);
        CONFIG.EMAIL_ALERTS = false;
    }
}

// Alert tracking
const alertsSent = new Map();

// ======================
// BUSINESS HOURS LOGIC
// ======================

function isWithinBusinessHours() {
    const now = new Date();
    
    // Get current time in EST/EDT
    const estTime = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }));
    const day = estTime.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const hour = estTime.getHours();
    
    const hours = CONFIG.BUSINESS_HOURS[day];
    if (!hours) return false;
    
    const isOpen = hour >= hours.start && hour < hours.end;
    
    return isOpen;
}

function getNextBusinessHoursTime() {
    const now = new Date();
    const estTime = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }));
    const day = estTime.toLocaleDateString('en-US', { weekday: 'long' });
    const hour = estTime.getHours();
    
    return `Next: ${day} ${hour < 12 ? hour : hour - 12}:00 ${hour < 12 ? 'AM' : 'PM'} EST`;
}

// ======================
// WEBHOOK ENDPOINTS
// ======================

app.post('/webhook/incoming-message', (req, res) => {
    console.log('📨 Incoming message webhook received');
    
    const {
        contactId,
        conversationId,
        locationId,
        messageBody,
        type,
        contactName,
        dateAdded,
        assignedTo // This field contains the assigned user
    } = req.body;

    if (!conversationId || !contactId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // CRITICAL: Filter by assigned user
    // Only track if assigned to "Support Team"
    if (assignedTo !== CONFIG.ASSIGNED_USER_FILTER) {
        console.log(`⏭️  Skipping - Not assigned to ${CONFIG.ASSIGNED_USER_FILTER} (assigned to: ${assignedTo || 'none'})`);
        return res.json({ 
            success: true, 
            skipped: true, 
            reason: `Not assigned to ${CONFIG.ASSIGNED_USER_FILTER}` 
        });
    }

    let conversation = conversations.get(conversationId);
    if (!conversation) {
        conversation = {
            conversationId,
            contactId,
            contactName: contactName || 'Unknown Contact',
            locationId,
            assignedTo,
            messages: [],
            lastInbound: null,
            lastResponse: null,
            needsResponse: false
        };
        conversations.set(conversationId, conversation);
    }

    const timestamp = dateAdded ? new Date(dateAdded).getTime() : Date.now();
    conversation.messages.push({
        id: `msg_${Date.now()}_${Math.random()}`,
        type: 'inbound',
        body: messageBody,
        channel: type,
        timestamp
    });

    conversation.lastInbound = timestamp;
    conversation.needsResponse = true;
    conversation.assignedTo = assignedTo; // Update assigned user

    console.log(`✅ Tracked Support Team message: ${contactName} (${conversationId})`);
    
    res.json({ success: true, conversationId, assignedTo });
});

app.post('/webhook/outgoing-message', (req, res) => {
    console.log('📤 Outgoing message webhook received');
    
    const {
        conversationId,
        messageBody,
        userId,
        dateAdded
    } = req.body;

    if (!conversationId) {
        return res.status(400).json({ error: 'Missing conversationId' });
    }

    const conversation = conversations.get(conversationId);
    if (!conversation) {
        console.log(`⚠️ Conversation ${conversationId} not tracked (might not be Support Team)`);
        return res.json({ success: true, note: 'Conversation not tracked' });
    }

    const timestamp = dateAdded ? new Date(dateAdded).getTime() : Date.now();
    conversation.messages.push({
        id: `msg_${Date.now()}_${Math.random()}`,
        type: 'outbound',
        body: messageBody,
        userId,
        timestamp
    });

    conversation.lastResponse = timestamp;
    conversation.needsResponse = false;

    alertsSent.delete(`${conversationId}-warning`);
    alertsSent.delete(`${conversationId}-critical`);

    console.log(`✅ Response recorded for Support Team: ${conversationId}`);
    
    res.json({ success: true, conversationId });
});

// ======================
// API ENDPOINTS
// ======================

app.get('/api/pending-messages', (req, res) => {
    const now = Date.now();
    const pending = [];

    for (const [conversationId, conversation] of conversations.entries()) {
        if (!conversation.needsResponse) continue;
        
        // Double-check it's still assigned to Support Team
        if (conversation.assignedTo !== CONFIG.ASSIGNED_USER_FILTER) continue;

        const elapsed = now - conversation.lastInbound;
        const lastMessage = conversation.messages
            .filter(m => m.type === 'inbound')
            .sort((a, b) => b.timestamp - a.timestamp)[0];

        pending.push({
            id: conversationId,
            conversationId,
            contactId: conversation.contactId,
            contactName: conversation.contactName,
            assignedTo: conversation.assignedTo,
            preview: lastMessage ? lastMessage.body.substring(0, 150) : 'No preview',
            channel: lastMessage ? lastMessage.channel : 'Unknown',
            timestamp: conversation.lastInbound,
            elapsed,
            status: getStatus(elapsed)
        });
    }

    pending.sort((a, b) => b.elapsed - a.elapsed);

    res.json({
        success: true,
        count: pending.length,
        messages: pending,
        businessHours: isWithinBusinessHours(),
        filter: CONFIG.ASSIGNED_USER_FILTER
    });
});

app.get('/api/conversation/:id', (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json({ success: true, conversation });
});

app.post('/api/mark-responded/:id', (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
    }
    
    conversation.needsResponse = false;
    conversation.lastResponse = Date.now();
    
    console.log(`✅ Manually marked as responded: ${req.params.id}`);
    res.json({ success: true });
});

app.delete('/api/conversations', (req, res) => {
    const count = conversations.size;
    conversations.clear();
    alertsSent.clear();
    console.log(`🗑️  Cleared ${count} conversations`);
    res.json({ success: true, message: `Cleared ${count} conversations` });
});

app.get('/health', (req, res) => {
    const businessHours = isWithinBusinessHours();
    res.json({
        success: true,
        status: 'running',
        conversations: conversations.size,
        pending: Array.from(conversations.values()).filter(c => c.needsResponse).length,
        uptime: Math.floor(process.uptime()),
        businessHours: businessHours,
        businessStatus: businessHours ? 'OPEN' : 'CLOSED',
        nextBusinessHours: businessHours ? 'Currently open' : getNextBusinessHoursTime(),
        config: {
            warningMinutes: CONFIG.WARNING_THRESHOLD / 60000,
            criticalMinutes: CONFIG.CRITICAL_THRESHOLD / 60000,
            emailAlertsEnabled: CONFIG.EMAIL_ALERTS,
            assignedUserFilter: CONFIG.ASSIGNED_USER_FILTER,
            timezone: CONFIG.TIMEZONE
        }
    });
});

// ======================
// EMAIL ALERTS
// ======================

function getStatus(elapsed) {
    if (elapsed >= CONFIG.CRITICAL_THRESHOLD) return 'critical';
    if (elapsed >= CONFIG.WARNING_THRESHOLD) return 'warning';
    return 'new';
}

async function sendEmailAlert(conversation, alertType) {
    if (!CONFIG.EMAIL_ALERTS || !emailTransporter) return;

    // CRITICAL: Only send emails during business hours
    if (!isWithinBusinessHours()) {
        console.log(`⏸️  Alert skipped (after hours): ${alertType} for ${conversation.contactName}`);
        return;
    }

    const alertKey = `${conversation.conversationId}-${alertType}`;
    if (alertsSent.has(alertKey)) return;

    const subject = alertType === 'critical' 
        ? `🚨 URGENT: JustInsurance Support - No response for ${CONFIG.CRITICAL_THRESHOLD/60000}+ minutes - ${conversation.contactName}`
        : `⚠️ WARNING: JustInsurance Support - No response for ${CONFIG.WARNING_THRESHOLD/60000}+ minutes - ${conversation.contactName}`;

    const lastMessage = conversation.messages
        .filter(m => m.type === 'inbound')
        .sort((a, b) => b.timestamp - a.timestamp)[0];

    const elapsed = Date.now() - conversation.lastInbound;
    const minutes = Math.floor(elapsed / 60000);

    const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 2px solid #1a3a52;">
            <div style="background: #1a3a52; color: white; padding: 20px; text-align: center;">
                <h1 style="margin: 0; font-size: 24px;">JustInsurance</h1>
                <p style="margin: 5px 0 0 0; opacity: 0.9;">Message Response Monitor</p>
            </div>
            <div style="background: ${alertType === 'critical' ? '#f44336' : '#ff9800'}; color: white; padding: 20px;">
                <h2 style="margin: 0; font-size: 22px;">${alertType === 'critical' ? '🚨 URGENT ALERT' : '⚠️ WARNING ALERT'}</h2>
                <p style="margin: 10px 0 0 0; font-size: 18px; font-weight: bold;">Support Team: Customer waiting ${minutes} minutes</p>
            </div>
            <div style="background: #f5f5f5; padding: 25px;">
                <h3 style="margin-top: 0; color: #1a3a52;">Contact: ${conversation.contactName}</h3>
                <div style="background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #1a3a52;">
                    <strong style="color: #666;">Last Message:</strong>
                    <p style="margin: 8px 0 0 0; color: #333; line-height: 1.5;">${lastMessage ? lastMessage.body : 'N/A'}</p>
                </div>
                <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
                    <tr>
                        <td style="padding: 8px 0; color: #666; font-weight: bold;">Channel:</td>
                        <td style="padding: 8px 0; color: #333;">${lastMessage ? lastMessage.channel : 'Unknown'}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #666; font-weight: bold;">Time Elapsed:</td>
                        <td style="padding: 8px 0; color: #333; font-weight: bold;">${minutes} minutes</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #666; font-weight: bold;">Assigned To:</td>
                        <td style="padding: 8px 0; color: #333;">${conversation.assignedTo}</td>
                    </tr>
                </table>
                ${conversation.locationId ? `
                <a href="https://app.gohighlevel.com/v2/location/${conversation.locationId}/conversations/${conversation.conversationId}" 
                   style="display: inline-block; background: #1a3a52; color: white; padding: 14px 28px; text-decoration: none; border-radius: 5px; margin-top: 15px; font-weight: bold; text-align: center; width: 100%; box-sizing: border-box;">
                    Open Conversation in GHL →
                </a>
                ` : ''}
            </div>
            <div style="background: #e0e0e0; padding: 15px; text-align: center;">
                <p style="margin: 0; font-size: 12px; color: #666;">
                    JustInsurance Support Team Monitor<br>
                    ${new Date().toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE })} EST
                </p>
            </div>
        </div>
    `;

    try {
        await emailTransporter.sendMail({
            from: `JustInsurance Alerts <${CONFIG.EMAIL_FROM}>`,
            to: CONFIG.EMAIL_TO.join(', '),
            subject: subject,
            html: htmlContent
        });

        alertsSent.set(alertKey, Date.now());
        console.log(`📧 ${alertType.toUpperCase()} email sent: ${conversation.contactName}`);
    } catch (error) {
        console.error('❌ Error sending email:', error.message);
    }
}

// ======================
// BACKGROUND MONITORING
// ======================

setInterval(() => {
    const now = Date.now();
    const businessHours = isWithinBusinessHours();
    let checked = 0;
    let warnings = 0;
    let criticals = 0;
    
    for (const [conversationId, conversation] of conversations.entries()) {
        if (!conversation.needsResponse) continue;
        
        // Skip if not Support Team
        if (conversation.assignedTo !== CONFIG.ASSIGNED_USER_FILTER) continue;
        
        checked++;

        const elapsed = now - conversation.lastInbound;
        
        if (elapsed >= CONFIG.CRITICAL_THRESHOLD) {
            criticals++;
            // Only send email during business hours
            if (businessHours) {
                sendEmailAlert(conversation, 'critical');
            }
        }
        else if (elapsed >= CONFIG.WARNING_THRESHOLD) {
            warnings++;
            // Only send email during business hours
            if (businessHours) {
                sendEmailAlert(conversation, 'warning');
            }
        }
    }
    
    if (checked > 0) {
        const status = businessHours ? '🟢 BUSINESS HOURS' : '🔴 AFTER HOURS';
        console.log(`🔍 ${status} - Checked ${checked} Support Team messages (${warnings} warnings, ${criticals} critical)`);
    }
}, 30000); // Check every 30 seconds

// ======================
// START SERVER
// ======================

const server = app.listen(CONFIG.PORT, () => {
    const businessHours = isWithinBusinessHours();
    console.log(`
╔════════════════════════════════════════════════════════════╗
║          JustInsurance Message Response Tracker            ║
╚════════════════════════════════════════════════════════════╝

🌐 Server: http://localhost:${CONFIG.PORT}
📡 Environment: ${process.env.NODE_ENV || 'development'}
${businessHours ? '🟢 STATUS: BUSINESS HOURS - Alerts ACTIVE' : '🔴 STATUS: AFTER HOURS - Alerts PAUSED'}

⚙️  JUSTINSURANCE CONFIGURATION:
   └─ Assigned User Filter: "${CONFIG.ASSIGNED_USER_FILTER}"
   └─ Warning Alert: ${CONFIG.WARNING_THRESHOLD/60000} minutes
   └─ Critical Alert: ${CONFIG.CRITICAL_THRESHOLD/60000} minutes
   └─ Email Alerts: ${CONFIG.EMAIL_ALERTS ? '✅ ENABLED' : '❌ DISABLED'}
   └─ Email Recipients: ${CONFIG.EMAIL_TO.join(', ')}
   └─ Timezone: ${CONFIG.TIMEZONE}

📅 BUSINESS HOURS (${CONFIG.TIMEZONE}):
   └─ Monday-Friday: 8:00 AM - 10:00 PM
   └─ Saturday-Sunday: 8:00 AM - 6:00 PM
   ${!businessHours ? `└─ ${getNextBusinessHoursTime()}` : ''}

📍 WEBHOOK ENDPOINTS:
   📨 Incoming: POST /webhook/incoming-message
      └─ Note: Only tracks if assignedTo = "${CONFIG.ASSIGNED_USER_FILTER}"
   📤 Outgoing: POST /webhook/outgoing-message

📍 API ENDPOINTS:
   📊 Pending Messages: GET /api/pending-messages
   🔍 Conversation: GET /api/conversation/:id
   ✅ Mark Responded: POST /api/mark-responded/:id
   🗑️  Clear All: DELETE /api/conversations
   ❤️  Health Check: GET /health

✨ System ready! Monitoring Support Team messages... 🚀
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down JustInsurance tracker gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down JustInsurance tracker gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = app;
