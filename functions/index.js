// Firebase v2 Modular Cloud Functions (Node.js 20 compatible)
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2/options');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1' });

const MAILCHIMP_API_KEY = defineSecret('MAILCHIMP_API_KEY');
const MAILCHIMP_LIST_ID = defineSecret('MAILCHIMP_LIST_ID');
const MAILCHIMP_DATA_CENTER = defineSecret('MAILCHIMP_DATA_CENTER');
const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');

// Mailchimp sync (only for original assessment with subscribeNewsletter)
exports.syncToMailchimp = onDocumentCreated({
  document: "surveyResponses/{docId}",
  secrets: [MAILCHIMP_API_KEY, MAILCHIMP_LIST_ID, MAILCHIMP_DATA_CENTER]
}, async (event) => {
  const data = event.data?.data();
  if (!data) return;

  const email = data.email;
  const wantsNewsletter = data.subscribeNewsletter;

  // Only sync if this is original assessment (has subscribeNewsletter field)
  if (!email || !wantsNewsletter || !data.hasOwnProperty('subscribeNewsletter')) {
    console.log("Skipping Mailchimp - either no email, no subscription, or practitioner assessment.");
    return;
  }

  const mailchimpApiKey = process.env.MAILCHIMP_API_KEY;
  const listId = process.env.MAILCHIMP_LIST_ID;
  const dataCenter = process.env.MAILCHIMP_DATA_CENTER;
  const hash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
  const url = `https://${dataCenter}.api.mailchimp.com/3.0/lists/${listId}/members/${hash}`;

  const subscriber = {
    email_address: email,
    status: "subscribed",
    tags: ["Audience", "PWA"]
  };

  try {
    console.log("Sending Mailchimp data:", subscriber);
    const response = await axios.put(url, subscriber, {
      headers: {
        Authorization: `apikey ${mailchimpApiKey}`,
        "Content-Type": "application/json"
      }
    });
    console.log("Mailchimp response:", response.data);
  } catch (error) {
    console.error("Mailchimp error:", error.response?.data || error.message);
  }
});

function getInterpretation(score) {
  if (score >= 252) return "Thriving";
  if (score >= 168) return "Balanced";
  if (score >= 84) return "Needs Attention";
  return "Critical";
}

function getScoreColor(score) {
  if (score >= 252) return "#22c55e"; // Green
  if (score >= 168) return "#3b82f6"; // Blue
  if (score >= 84) return "#f59e0b";  // Orange
  return "#ef4444"; // Red
}

function getDomainInterpretation(score) {
  if (score >= 18) return { label: "Thriving", color: "#22c55e" };
  if (score >= 12) return { label: "Balanced", color: "#3b82f6" };
  if (score >= 6) return { label: "Needs Attention", color: "#f59e0b" };
  return { label: "Critical", color: "#ef4444" };
}

// Updated function to handle BOTH original and practitioner assessments
exports.sendResultsEmail = onDocumentCreated({
  document: "surveyResponses/{docId}",
  secrets: [SENDGRID_API_KEY]
}, async (event) => {
  const data = event.data?.data();
  if (!data) return;

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  // Domain descriptions
  const domainDescriptions = {
    "'Āina Momona": "Connection to land and environmental stewardship",
    "Waiwai": "Financial health and decision-making",
    "Financial Wellness": "Financial health and decision-making",
    "Social Wellness": "Relationships with friends, family, and co-workers",
    "Environmental Wellness": "Sustainable surroundings that support well-being",
    "Spiritual Wellness": "Sense of meaning, belief, or faith practices",
    "Occupational Wellness": "Purpose and fulfillment in work or daily roles",
    "Pilina": "Close-knit connections and trust in relationships",
    "Emotional Wellness": "Balance, resilience, and emotional awareness",
    "Ke Akua Mana": "Spiritual and ancestral power, identity, and connection",
    "Intellectual Wellness": "Lifelong learning and cognitive engagement",
    "'Ōiwi": "Cultural identity and personal growth",
    "Ea": "Empowerment, agency, and life direction",
    "Physical Wellness": "Bodily health, activity, and nourishment",
    "Overall Wellness": "General wellness perspective"
  };

  // Determine assessment type and extract emails
  const isPractitionerAssessment = data.hasOwnProperty('practitionerEmail') || data.hasOwnProperty('clientEmail');
  
  let emailsToSend = [];
  
  if (isPractitionerAssessment) {
    // Practitioner assessment - dual email system
    if (data.clientEmail) {
      emailsToSend.push({ email: data.clientEmail, type: 'client' });
    }
    if (data.practitionerEmail) {
      emailsToSend.push({ email: data.practitionerEmail, type: 'practitioner' });
    }
  } else {
    // Original assessment - single email
    if (data.email) {
      emailsToSend.push({ email: data.email, type: 'original' });
    }
  }

  // Skip if no emails
  if (emailsToSend.length === 0) {
    console.log("No email addresses provided – skipping results email.");
    return;
  }

  // Generate domain scores HTML
  const generateDomainScoresHtml = () => {
    return Object.entries(data.domainScores || {})
      .filter(([domain]) => domain !== "Attention Check" && domain !== "Overall Wellness")
      .map(([domain, score]) => {
        const interpretation = getDomainInterpretation(score);
        const description = domainDescriptions[domain] || "";
        
        return `<li style="margin-bottom: 12px; list-style: none;">
          <div style="font-weight: 600; color: ${interpretation.color}; margin-bottom: 2px;">
            ${domain}: ${score} - ${interpretation.label}
          </div>
          ${description ? `<div style="font-size: 0.9em; color: #666; margin-left: 0; font-style: italic;">
            ${description}
          </div>` : ''}
        </li>`;
      })
      .join("");
  };

  const domainScoresHtml = generateDomainScoresHtml();

  // Send emails
  const emailPromises = emailsToSend.map(({ email, type }) => {
    let subject, htmlContent;

    if (type === 'original') {
      // Original assessment email (webapp with sales funnel)
      subject = "Your Pinnacle Wellness Assessment Results";
      htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <link href="https://fonts.googleapis.com/css2?family=Alice&family=Open+Sans:300,400,600,700&display=swap" rel="stylesheet" />
</head>
<body style="background: linear-gradient(135deg, #89C9D4 0%, #b8dde1 100%); font-family: 'Alice', serif; color: #2A6972; padding: 1.5em; margin: 0;">
  <div style="max-width: 600px; margin: auto; background: white; border-radius: 15px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2); overflow: hidden;">
    <div style="background: linear-gradient(135deg, #2A6972 0%, #89C9D4 100%); color: white; padding: 30px; text-align: center;">
      <h1 style="margin: 0; font-size: 1.8rem; font-family: 'Open Sans', sans-serif; font-weight: 700; text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);">🌺 Your Wellness Assessment Results</h1>
      <p style="margin: 10px 0 0 0; font-size: 1rem; opacity: 0.9;">Pinnacle Wellness Assessment</p>
    </div>
    
    <div style="padding: 30px;">
      <p style="font-size: 1.1em; line-height: 1.6;">Aloha! Thank you for completing the Pinnacle Wellness Assessment. Here are your personalized results:</p>
      
      <div style="background: linear-gradient(135deg, #2A6972 0%, #89C9D4 100%); color: white; padding: 25px; border-radius: 12px; text-align: center; margin: 25px 0; box-shadow: 0 4px 15px rgba(42, 105, 114, 0.3);">
        <h2 style="margin: 0 0 10px 0; color: white; font-family: 'Open Sans', sans-serif;">Overall Wellness Score</h2>
        <div style="font-size: 2.2rem; font-weight: 700; margin: 10px 0;">${data.totalScore}</div>
        <div style="font-size: 1.2rem; font-weight: 600;">${getInterpretation(data.totalScore)}</div>
      </div>

      <div style="background: #f8f9fa; border-radius: 12px; padding: 25px; margin: 25px 0;">
        <h3 style="margin: 0 0 15px 0; color: #2A6972; font-family: 'Open Sans', sans-serif;">Your Domain Scores</h3>
        <ul style="padding-left: 0; list-style: none; margin: 0;">
          ${domainScoresHtml}
        </ul>
      </div>

      <div style="background: rgba(137, 201, 212, 0.1); border-radius: 12px; padding: 25px; margin: 25px 0; text-align: center;">
        <h3 style="color: #2A6972; margin-bottom: 15px; font-family: 'Open Sans', sans-serif;">Want Help Turning Your Insights Into Action?</h3>
        <p style="margin: 0 0 20px 0; line-height: 1.6;">Schedule a free 25-minute strategy session with <strong>Adam Grimm</strong>, the author of the Aloha Wellness Guide and founder of Pegasus Realm. Together, we'll explore your results, clarify your direction, and begin building a personalized wellness strategy.</p>
        <a href="https://tidycal.com/adamgrimm/consultation20240315005818" style="display: inline-block; background: linear-gradient(135deg, #2A6972 0%, #89C9D4 100%); color: white; font-family: 'Open Sans', sans-serif; font-size: 1.1em; font-weight: 600; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin-bottom: 15px;">📅 Book My Free Session</a>
        <p style="margin: 15px 0 0 0; font-size: 0.9em; line-height: 1.5;">
          Prefer to learn more first? Visit <a href="https://pegasusrealm.com" style="color: #2A6972; font-weight: 600; text-decoration: underline;">Pegasus Realm</a> for additional wellness resources and tools.
        </p>
      </div>

      <div style="text-align: center; padding: 20px; border-top: 1px solid rgba(42, 105, 114, 0.1); margin-top: 30px;">
        <img src="https://pegasusrealm.com/wp-content/uploads/2023/05/cropped-Logo-Circle-No-Text-1.png" alt="Pegasus Realm" style="width: 40px; height: 40px; margin-bottom: 10px;">
        <p style="margin: 0; font-size: 0.9rem; color: #666;"><strong>The Aloha Wellness Guide is brought to you free by Pegasus Realm and Present Mind Institute of Hawaii.</strong></p>
        <p style="margin: 10px 0 0 0; font-size: 0.85rem; color: #666;">Mahalo, Adam & Taylor</p>
      </div>
    </div>
  </div>
</body>
</html>`;
    } else if (type === 'client') {
      // Practitioner assessment - client email
      subject = "Your Pinnacle Wellness Assessment Results";
      htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <link href="https://fonts.googleapis.com/css2?family=Alice&family=Open+Sans:300,400,600,700&display=swap" rel="stylesheet" />
</head>
<body style="background: linear-gradient(135deg, #89C9D4 0%, #b8dde1 100%); font-family: 'Alice', serif; color: #2A6972; padding: 1.5em; margin: 0;">
  <div style="max-width: 600px; margin: auto; background: white; border-radius: 15px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2); overflow: hidden;">
    <div style="background: linear-gradient(135deg, #2A6972 0%, #89C9D4 100%); color: white; padding: 30px; text-align: center;">
      <h1 style="margin: 0; font-size: 1.8rem; font-family: 'Open Sans', sans-serif; font-weight: 700; text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);">🌺 Your Wellness Assessment Results</h1>
      <p style="margin: 10px 0 0 0; font-size: 1rem; opacity: 0.9;">Pinnacle Wellness Assessment</p>
    </div>
    
    <div style="padding: 30px;">
      <p style="font-size: 1.1em; line-height: 1.6;">Thank you for completing the Pinnacle Wellness Assessment! Here are your personalized results:</p>
      
      <div style="background: linear-gradient(135deg, #2A6972 0%, #89C9D4 100%); color: white; padding: 25px; border-radius: 12px; text-align: center; margin: 25px 0; box-shadow: 0 4px 15px rgba(42, 105, 114, 0.3);">
        <h2 style="margin: 0 0 10px 0; color: white; font-family: 'Open Sans', sans-serif;">Overall Wellness Score</h2>
        <div style="font-size: 2.2rem; font-weight: 700; margin: 10px 0;">${data.totalScore}</div>
        <div style="font-size: 1.2rem; font-weight: 600;">${getInterpretation(data.totalScore)}</div>
      </div>

      <div style="background: #f8f9fa; border-radius: 12px; padding: 25px; margin: 25px 0;">
        <h3 style="margin: 0 0 15px 0; color: #2A6972; font-family: 'Open Sans', sans-serif;">Domain Breakdown</h3>
        <ul style="padding-left: 0; list-style: none; margin: 0;">
          ${domainScoresHtml}
        </ul>
      </div>

      <div style="background: rgba(137, 201, 212, 0.1); border-radius: 12px; padding: 20px; margin: 25px 0;">
        <h3 style="color: #2A6972; margin-bottom: 10px; font-family: 'Open Sans', sans-serif;">Using Your Results</h3>
        <p style="margin: 0; line-height: 1.6;">These scores provide insight into your current wellness across multiple life dimensions. Consider discussing these results with your wellness practitioner to develop personalized strategies for growth.</p>
      </div>

      <div style="text-align: center; padding: 20px; border-top: 1px solid rgba(42, 105, 114, 0.1); margin-top: 30px;">
        <p style="margin: 0; font-size: 0.9rem; color: #666;"><strong>The Aloha Wellness Guide is brought to you free by Pegasus Realm and Present Mind Institute of Hawaii.</strong></p>
      </div>
    </div>
  </div>
</body>
</html>`;
    } else {
      // Practitioner assessment - practitioner email
      subject = "Client Wellness Assessment Results";
      htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <link href="https://fonts.googleapis.com/css2?family=Alice&family=Open+Sans:300,400,600,700&display=swap" rel="stylesheet" />
</head>
<body style="background: linear-gradient(135deg, #89C9D4 0%, #b8dde1 100%); font-family: 'Alice', serif; color: #2A6972; padding: 1.5em; margin: 0;">
  <div style="max-width: 600px; margin: auto; background: white; border-radius: 15px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2); overflow: hidden;">
    <div style="background: linear-gradient(135deg, #2A6972 0%, #89C9D4 100%); color: white; padding: 30px; text-align: center;">
      <h1 style="margin: 0; font-size: 1.8rem; font-family: 'Open Sans', sans-serif; font-weight: 700; text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);">📊 Client Assessment Results</h1>
      <p style="margin: 10px 0 0 0; font-size: 1rem; opacity: 0.9;">Pinnacle Wellness Assessment</p>
    </div>
    
    <div style="padding: 30px;">
      <p style="font-size: 1.1em; line-height: 1.6;">A client has completed the Pinnacle Wellness Assessment. Here are their results for your review:</p>
      
      <div style="background: #e8f4f8; border-left: 4px solid #2A6972; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
        <p style="margin: 0; font-family: 'Open Sans', sans-serif;"><strong>Assessment Date:</strong> ${new Date(data.timestamp?.toDate()).toLocaleDateString()}</p>
        ${data.clientEmail ? `<p style="margin: 5px 0 0 0; font-family: 'Open Sans', sans-serif;"><strong>Client Email:</strong> ${data.clientEmail}</p>` : ''}
      </div>
      
      <div style="background: linear-gradient(135deg, #2A6972 0%, #89C9D4 100%); color: white; padding: 25px; border-radius: 12px; text-align: center; margin: 25px 0; box-shadow: 0 4px 15px rgba(42, 105, 114, 0.3);">
        <h2 style="margin: 0 0 10px 0; color: white; font-family: 'Open Sans', sans-serif;">Overall Wellness Score</h2>
        <div style="font-size: 2.2rem; font-weight: 700; margin: 10px 0;">${data.totalScore}</div>
        <div style="font-size: 1.2rem; font-weight: 600;">${getInterpretation(data.totalScore)}</div>
      </div>

      <div style="background: #f8f9fa; border-radius: 12px; padding: 25px; margin: 25px 0;">
        <h3 style="margin: 0 0 15px 0; color: #2A6972; font-family: 'Open Sans', sans-serif;">Domain Breakdown</h3>
        <ul style="padding-left: 0; list-style: none; margin: 0;">
          ${domainScoresHtml}
        </ul>
      </div>

      <div style="background: rgba(137, 201, 212, 0.1); border-radius: 12px; padding: 20px; margin: 25px 0;">
        <h3 style="color: #2A6972; margin-bottom: 10px; font-family: 'Open Sans', sans-serif;">For Practitioners</h3>
        <p style="margin: 0; line-height: 1.6;">These results can guide your wellness conversations and help identify priority areas for intervention. Consider the client's strongest domains as resources and lowest scoring areas as potential focal points.</p>
      </div>

      <div style="text-align: center; padding: 20px; border-top: 1px solid rgba(42, 105, 114, 0.1); margin-top: 30px;">
        <p style="margin: 0; font-size: 0.9rem; color: #666;"><strong>The Aloha Wellness Guide is brought to you free by Pegasus Realm and Present Mind Institute of Hawaii.</strong></p>
      </div>
    </div>
  </div>
</body>
</html>`;
    }

    return sgMail.send({
      to: email,
      from: "support@pegasusrealm.com",
      subject: subject,
      html: htmlContent
    });
  });

  try {
    const responses = await Promise.all(emailPromises);
    console.log("Assessment emails sent successfully:");
    responses.forEach((response, index) => {
      const { type } = emailsToSend[index];
      console.log(`${type} email - Status: ${response[0]?.statusCode}`);
    });
  } catch (error) {
    console.error("Failed to send assessment emails:");
    console.error("Error message:", error.message);
    console.error("Error response body:", error.response?.body);
    console.error("Full error object:", error);
  }
});