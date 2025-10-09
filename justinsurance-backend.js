// JustInsurance Message Response Tracker - IMPROVED VERSION WITH DEBUGGING
// Filters for "Support Team" assigned conversations only
// Sends alerts only during business hours: Mon-Fri 8am-10pm, Sat-Sun 8am-6pm EST

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const app = express();

app.use(cors());
app.use(express.json());

// In-memory storage
const conversations = new Map();

// DEBUGGING: Store all webhook calls for inspection
const webhookLog = [];
const MAX_WEBHOOK_LOG = 100;

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    WARNING_THRESHOLD: (process.env.WARNING_MINUTES || 5) * 60 * 1000,
    CRITICAL_THRESHOLD: (process.env.CRITICAL_MINUTES || 15) * 60 * 1000,
    EMAIL_ALERTS: process.env.EMAIL_ALERTS_ENABLED !== 'false',
    EMAIL_FROM: process.env.EMAIL_FROM || 'alerts@justinsurance.com',
    EMAIL_TO: process.env.EMAIL_TO ? process.env.EMAIL_TO.split(',') : ['support@justinsurance.com'],
    SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
    SMTP_PORT: parseInt(process.env.SMTP_PORT) || 587,
    SMTP_SECURE: process.env.SMTP_SECURE === 'true' || false,
    SMTP_USER: process.env.SMTP_USER || 'your-email@gmail.com',
    SMTP_PASS: process.env.SMTP_PASS || 'your-app-password',
    
    // JustInsurance specific settings
    ASSIGNED_USER_FILTER: 'Support Team',
    
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
// HELPER FUNCTIONS
// ======================

function logWebhook(type, data) {
    const entry = {
        type,
        timestamp: new Date().toISOString(),
        data
    };
    webhookLog.unshift(entry);
    if (webhookLog.length > MAX_WEBHOOK_LOG) {
        webhookLog.pop();
    }
}

function normalizeConversationId(conversationId, contactId) {
    // If conversationId exists and is valid, use it
    if (conversationId && conversationId.trim() !== '') {
        return conversationId;
    }
    // Otherwise, create one from contactId
    return `conv_${contactId}`;
}

// ======================
// BUSINESS HOURS LOGIC
// ======================

function isWithinBusinessHours() {
    const now = new Date();
    const estTime = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }));
    const day = estTime.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const hour = estTime.getHours();
    
    const hours = CONFIG.BUSINESS_HOURS[day];
    if (!hours) return false;
    
    return hour >= hours.start && hour < hours.end;
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
    const timestamp = Date.now();
    console.log('\n📨 ==================== INCOMING MESSAGE ====================');
    console.log('⏰ Server time:', new Date().toISOString());
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
    
    logWebhook('incoming', req.body);
    
    // Extract fields with fallbacks
    const customData = req.body.customData || {};
    
    const contactId = customData.contactId || req.body.contactId || req.body.contact_id || req.body.ContactId || req.body.contactid;
    let conversationId = customData.conversationId || req.body.conversationId || req.body.conversation_id || req.body.ConversationId || req.body.conversationid;
    let locationId = customData.locationId || req.body.locationId || req.body.location_id || req.body.LocationId;
    let messageBody = customData.messageBody || req.body.messageBody || req.body.message_body || req.body.body || req.body.MessageBody;
    let type = customData.type || req.body.type || req.body.message_type || req.body.Type || 'SMS';
    let contactName = customData.contactName || req.body.contactName || req.body.contact_name || req.body.name || req.body.ContactName || req.body.full_name || req.body.email || 'Unknown Contact';
    let assignedTo = customData.assignedTo || req.body.assignedTo || req.body.assigned_to || req.body.AssignedTo;

    // Check nested objects
    if (!locationId && req.body.location) {
        locationId = req.body.location.id;
    }
    
    if (req.body.message) {
        if (!messageBody) messageBody = req.body.message.body;
        if (!type || type === 'SMS') type = req.body.message.type || 'SMS';
    }

    // Normalize conversation ID
    conversationId = normalizeConversationId(conversationId, contactId);

    console.log('📋 Extracted fields:');
    console.log('   contactId:', contactId);
    console.log('   conversationId:', conversationId);
    console.log('   locationId:', locationId);
    console.log('   contactName:', contactName);
    console.log('   assignedTo:', assignedTo);
    console.log('   type:', type);
    console.log('   messageBody:', messageBody ? messageBody.substring(0, 100) + '...' : 'none');

    if (!conversationId || !contactId) {
        console.log('❌ REJECTED: Missing required fields!');
        return res.status(400).json({ 
            error: 'Missing required fields',
            received: Object.keys(req.body),
            needed: ['contactId', 'conversationId (or will be generated)']
        });
    }

    // Filter by assigned user
    if (assignedTo && assignedTo !== CONFIG.ASSIGNED_USER_FILTER) {
        console.log(`⭐️ SKIPPED: Not assigned to ${CONFIG.ASSIGNED_USER_FILTER} (assigned to: ${assignedTo})`);
        return res.json({ 
            success: true, 
            skipped: true, 
            reason: `Not assigned to ${CONFIG.ASSIGNED_USER_FILTER}` 
        });
    }

    // Get or create conversation
    let conversation = conversations.get(conversationId);
    const isNew = !conversation;
    
    if (!conversation) {
        conversation = {
            conversationId,
            contactId,
            contactName,
            locationId,
            assignedTo: assignedTo || 'Support Team',
            messages: [],
            lastInbound: null,
            lastResponse: null,
            needsResponse: false,
            createdAt: timestamp
        };
        conversations.set(conversationId, conversation);
        console.log('🆕 NEW conversation created');
    } else {
        console.log('♻️ EXISTING conversation found');
    }

    // Add message
    conversation.messages.push({
        id: `msg_${timestamp}_${Math.random()}`,
        type: 'inbound',
        body: messageBody || 'No message body',
        channel: type,
        timestamp
    });

    conversation.lastInbound = timestamp;
    conversation.needsResponse = true;
    conversation.assignedTo = assignedTo || 'Support Team';

    console.log(`✅ SUCCESS: Tracked message for ${contactName}`);
    console.log(`   Conversation: ${conversationId}`);
    console.log(`   Needs Response: ${conversation.needsResponse}`);
    console.log(`   Total messages in this conversation: ${conversation.messages.length}`);
    console.log('=========================================================\n');
    
    res.json({ 
        success: true, 
        conversationId, 
        contactId,
        assignedTo: conversation.assignedTo,
        isNew,
        timestamp 
    });
});

app.post('/webhook/outgoing-message', (req, res) => {
    const timestamp = Date.now();
    console.log('\n📤 ==================== OUTGOING MESSAGE ====================');
    console.log('⏰ Server time:', new Date().toISOString());
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
    
    logWebhook('outgoing', req.body);
    
    // Extract fields with fallbacks
    const customData = req.body.customData || {};
    let conversationId = customData.conversationId || req.body.conversationId || req.body.conversation_id || req.body.ConversationId;
    const contactId = customData.contactId || req.body.contactId || req.body.contact_id || req.body.ContactId;
    const messageBody = customData.messageBody || req.body.messageBody || req.body.message_body || req.body.body || req.body.MessageBody;
    const userId = customData.userId || req.body.userId || req.body.user_id || req.body.UserId;

    console.log('📋 Extracted fields:');
    console.log('   conversationId:', conversationId);
    console.log('   contactId:', contactId);
    console.log('   userId:', userId);

    // Try to normalize conversation ID if we have contactId
    if (contactId) {
        conversationId = normalizeConversationId(conversationId, contactId);
        console.log('   normalized conversationId:', conversationId);
    }

    if (!conversationId) {
        console.log('❌ REJECTED: Missing conversationId');
        return res.status(400).json({ error: 'Missing conversationId' });
    }

    // Try to find the conversation
    let conversation = conversations.get(conversationId);
    
    // If not found and we have contactId, try the conv_ format
    if (!conversation && contactId) {
        const altConvId = `conv_${contactId}`;
        conversation = conversations.get(altConvId);
        if (conversation) {
            console.log(`🔄 Found conversation using alternative ID: ${altConvId}`);
            conversationId = altConvId;
        }
    }

    if (!conversation) {
        console.log(`⚠️ Conversation ${conversationId} not found in tracking`);
        console.log(`   Currently tracking ${conversations.size} conversations:`);
        for (const [key, conv] of conversations.entries()) {
            console.log(`     - ${key} (${conv.contactName})`);
        }
        return res.json({ success: true, note: 'Conversation not tracked', conversationId });
    }

    // Add outbound message
    conversation.messages.push({
        id: `msg_${timestamp}_${Math.random()}`,
        type: 'outbound',
        body: messageBody || 'Response sent',
        userId,
        timestamp
    });

    conversation.lastResponse = timestamp;
    conversation.needsResponse = false;

    // Clear alerts
    alertsSent.delete(`${conversationId}-warning`);
    alertsSent.delete(`${conversationId}-critical`);

    console.log(`✅ SUCCESS: Response recorded`);
    console.log(`   Conversation: ${conversationId}`);
    console.log(`   Contact: ${conversation.contactName}`);
    console.log(`   Needs Response: ${conversation.needsResponse}`);
    console.log(`   Total messages: ${conversation.messages.length}`);
    console.log('=========================================================\n');
    
    res.json({ success: true, conversationId, contactId, needsResponse: false });
});

// ======================
// DEBUGGING ENDPOINTS
// ======================

app.get('/api/debug/webhooks', (req, res) => {
    res.json({
        success: true,
        count: webhookLog.length,
        webhooks: webhookLog.slice(0, 20) // Last 20 webhooks
    });
});

app.get('/api/debug/conversations', (req, res) => {
    const conversationList = Array.from(conversations.entries()).map(([id, conv]) => ({
        id,
        contactName: conv.contactName,
        contactId: conv.contactId,
        assignedTo: conv.assignedTo,
        needsResponse: conv.needsResponse,
        messageCount: conv.messages.length,
        lastInbound: conv.lastInbound ? new Date(conv.lastInbound).toISOString() : null,
        lastResponse: conv.lastResponse ? new Date(conv.lastResponse).toISOString() : null,
        elapsed: conv.lastInbound ? Date.now() - conv.lastInbound : 0
    }));

    res.json({
        success: true,
        totalConversations: conversations.size,
        conversations: conversationList
    });
});

app.get('/api/debug/conversation/:id', (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (!conversation) {
        return res.status(404).json({ 
            error: 'Conversation not found',
            availableIds: Array.from(conversations.keys())
        });
    }
    res.json({ success: true, conversation });
});

// ======================
// API ENDPOINTS
// ======================

app.get('/api/pending-messages', (req, res) => {
    const now = Date.now();
    const pending = [];

    console.log(`\n🔍 Checking pending messages at ${new Date().toISOString()}`);
    console.log(`   Total conversations tracked: ${conversations.size}`);

    for (const [conversationId, conversation] of conversations.entries()) {
        console.log(`   Checking ${conversationId}:`);
        console.log(`     - needsResponse: ${conversation.needsResponse}`);
        console.log(`     - assignedTo: ${conversation.assignedTo}`);
        
        if (!conversation.needsResponse) {
            console.log(`     ⏭️ Skipped (already responded)`);
            continue;
        }
        
        if (conversation.assignedTo !== CONFIG.ASSIGNED_USER_FILTER) {
            console.log(`     ⏭️ Skipped (not Support Team)`);
            continue;
        }

        const elapsed = now - conversation.lastInbound;
        const minutes = Math.floor(elapsed / 60000);
        
        console.log(`     ✅ PENDING - ${minutes} minutes elapsed`);

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

    console.log(`   📊 Returning ${pending.length} pending messages\n`);

    res.json({
        success: true,
        count: pending.length,
        messages: pending,
        businessHours: isWithinBusinessHours(),
        filter: CONFIG.ASSIGNED_USER_FILTER,
        serverTime: new Date().toISOString()
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
    webhookLog.length = 0;
    console.log(`🗑️ Cleared ${count} conversations`);
    res.json({ success: true, message: `Cleared ${count} conversations` });
});

app.get('/health', (req, res) => {
    const businessHours = isWithinBusinessHours();
    const pending = Array.from(conversations.values()).filter(c => c.needsResponse && c.assignedTo === CONFIG.ASSIGNED_USER_FILTER);
    
    res.json({
        success: true,
        status: 'running',
        serverTime: new Date().toISOString(),
        conversations: conversations.size,
        pending: pending.length,
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

    if (!isWithinBusinessHours()) {
        console.log(`⏸️ Alert skipped (after hours): ${alertType} for ${conversation.contactName}`);
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
        if (conversation.assignedTo !== CONFIG.ASSIGNED_USER_FILTER) continue;
        
        checked++;

        const elapsed = now - conversation.lastInbound;
        
        if (elapsed >= CONFIG.CRITICAL_THRESHOLD) {
            criticals++;
            if (businessHours) {
                sendEmailAlert(conversation, 'critical');
            }
        }
        else if (elapsed >= CONFIG.WARNING_THRESHOLD) {
            warnings++;
            if (businessHours) {
                sendEmailAlert(conversation, 'warning');
            }
        }
    }
    
    if (checked > 0) {
        const status = businessHours ? '🟢 BUSINESS HOURS' : '🔴 AFTER HOURS';
        console.log(`🔍 ${status} - Checked ${checked} Support Team messages (${warnings} warnings, ${criticals} critical)`);
    }
}, 30000);

// ======================
// START SERVER
// ======================

const server = app.listen(CONFIG.PORT, () => {
    const businessHours = isWithinBusinessHours();
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║          JustInsurance Message Response Tracker            ║
║                    IMPROVED VERSION                        ║
╚═══════════════════════════════════════════════════════════╝

🌐 Server: http://localhost:${CONFIG.PORT}
📡 Environment: ${process.env.NODE_ENV || 'development'}
${businessHours ? '🟢 STATUS: BUSINESS HOURS - Alerts ACTIVE' : '🔴 STATUS: AFTER HOURS - Alerts PAUSED'}

⚙️ CONFIGURATION:
   └─ Assigned User Filter: "${CONFIG.ASSIGNED_USER_FILTER}"
   └─ Warning Alert: ${CONFIG.WARNING_THRESHOLD/60000} minutes
   └─ Critical Alert: ${CONFIG.CRITICAL_THRESHOLD/60000} minutes
   └─ Email Alerts: ${CONFIG.EMAIL_ALERTS ? '✅ ENABLED' : '❌ DISABLED'}
   └─ Timezone: ${CONFIG.TIMEZONE}

📅 BUSINESS HOURS (${CONFIG.TIMEZONE}):
   └─ Monday-Friday: 8:00 AM - 10:00 PM
   └─ Saturday-Sunday: 8:00 AM - 6:00 PM

🔧 DEBUGGING ENDPOINTS:
   🐛 Recent Webhooks: GET /api/debug/webhooks
   🐛 All Conversations: GET /api/debug/conversations
   🐛 Specific Conversation: GET /api/debug/conversation/:id

📥 WEBHOOK ENDPOINTS:
   📨 Incoming: POST /webhook/incoming-message
   📤 Outgoing: POST /webhook/outgoing-message

📊 API ENDPOINTS:
   📊 Pending Messages: GET /api/pending-messages
   📝 Conversation: GET /api/conversation/:id
   ✅ Mark Responded: POST /api/mark-responded/:id
   🗑️ Clear All: DELETE /api/conversations
   ❤️ Health Check: GET /health

✨ System ready! Monitoring Support Team messages... 🚀
    `);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = app;
