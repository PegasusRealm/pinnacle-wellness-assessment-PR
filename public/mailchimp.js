const axios = require('axios');

const MAILCHIMP_API_KEY = "7012676df15df368fbc616a5b4f25af3-us12";
const AUDIENCE_ID = "1c98cb3a97";
const DATACENTER = MAILCHIMP_API_KEY.split('-')[1];
const BASE_URL = `https://${DATACENTER}.api.mailchimp.com/3.0`;

exports.addSubscriber = async (email) => {
  try {
    const response = await axios.post(
      `${BASE_URL}/lists/${AUDIENCE_ID}/members`,
      {
        email_address: email,
        status: "subscribed",
        tags: ["Audience", "AWG"]
      },
      {
        auth: {
          username: "anystring",
          password: MAILCHIMP_API_KEY
        }
      }
    );
    console.log("✅ Mailchimp subscribed:", email);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 400 && error.response.data.title === 'Member Exists') {
      console.log("ℹ️ Already subscribed:", email);
    } else {
      console.error("❌ Mailchimp error:", error.response?.data || error.message);
    }
  }
};