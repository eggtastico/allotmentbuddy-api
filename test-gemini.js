const { GoogleGenerativeAI } = require("@google/generative-ai");

const apiKey = process.env.GOOGLE_API_KEY;
console.log("Testing Gemini API...");

if (!apiKey) {
  console.error("✗ GOOGLE_API_KEY not set");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

(async () => {
  try {
    console.log("Sending test request...");
    const result = await model.generateContent("Say OK");
    const reply = result.response.text();
    console.log("✓ Success:", reply);
  } catch (err) {
    console.error("✗ Error:", err.message);
  }
})();
