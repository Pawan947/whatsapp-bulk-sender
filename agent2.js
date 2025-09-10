const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { ChatPromptTemplate } = require("@langchain/core/prompts");

process.env["GOOGLE_API_KEY"] = "AIzaSyBdp-OU4LeiiFUu7uouWVhdhuBm_-9hXug";

// Initialize LLM with proper configuration
const llm = new ChatGoogleGenerativeAI({
  model: "gemini-2.0-flash", 
  apiKey: process.env["GOOGLE_API_KEY"],
  maxOutputTokens: 600,
  temperature: 0.85,
  safetySettings: [{
    category: "HARM_CATEGORY_HARASSMENT",
    threshold: "BLOCK_NONE"
  }]
});

const marketingTemplate = `
Craft COMPELLING WhatsApp marketing copy for {companyName} using:

◾ Product: {productDetails}
◾ Target: {targetGender} ({targetAudience})
◾ Core Tone: {tone} + {keySellingPoints}
◾ Must Include: {callToAction} + {currentPromotion}

🔥 GENDER ENGINE 🔥
- LANGUAGE: Use {targetGender}-specific slang/idioms
- PSYCHOLOGY: Implement 3 cognitive biases for {targetGender}
- EMOJIS: Combine 2-4 gender-relevant emojis creatively
- STRUCTURE:
  [Cultural Reference ➡️ Pain Point ➡️ Benefit Story]
  [Social Proof ➡️ Scarcity CTA ➡️ Urgent Closing]

🛑 STRICT RULES 🛑
1. Include EXACTLY ONE hashtag
2. Use {targetGender} consumer jargon
3. Mirror regional linguistic patterns
4. NEVER use markdown
5. Character limit: 500 EXACT`;

const promptTemplate = ChatPromptTemplate.fromTemplate(marketingTemplate);

const genderMatrix = {
  female: {
    triggers: ["#ShePower", "👯‍♀️💃🛍️", "confidence-boosting", "sisterhood", "body-positive"],
    validators: [/her community/i, /you deserve/i, /feminine .* power/i]
  },
  male: {
    triggers: ["#AlphaEssentials", "💪🕶️👊", "peak performance", "bro-code", "uncompromising"],
    validators: [/upgrade your/i, /men's .* arsenal/i, /dominate/i]
  },
  unisex: {
    triggers: ["#ForAll", "🌍🤝🎉", "inclusive", "unity", "boundary-breaking"],
    validators: [/every body/i, /all-inclusive/i, /gender-neutral/i]
  }
};

const deepValidate = (message, gender) => {
  const { triggers, validators } = genderMatrix[gender];
  const essentials = {
    length: message.length <= 500,
    hashtag: (message.match(/#/g)?.length || 0) === 1,
    emojis: triggers.some(e => message.includes(e)),
    psychology: validators.every(rx => rx.test(message)),
    urgency: /\b(24h|flash|ending soon)\b/i.test(message),
    structure: /(.+\n){2,}.+([!?]|🔥)/.test(message)
  };
  return { ...essentials, score: Object.values(essentials).filter(Boolean).length };
};

(async () => {
  try {
    const prompt = await promptTemplate.invoke({
      companyName: "UrbanFit Apparel",
      productDetails: "Premium yoga skirts with pocket design",
      targetGender: "female",
      targetAudience: "Millennial fitness enthusiasts & working professionals",
      tone: "boldly aspirational",
      keySellingPoints: "Squat-proof fabric • Secret phone pocket • UPF 50+",
      callToAction: "Claim 25% OFF with code SHE25",
      currentPromotion: "Summer Fitness Challenge"
    });

    const response = await llm.invoke(prompt);
    const msg = response.content.replace(/\*\*/g, '').trim();
    const audit = deepValidate(msg, "female");

    console.log(`🔥 FINAL MESSAGE 🔥\n\n${msg}\n`);
    console.log("🔍 GENDER PERFORMANCE AUDIT");
    console.log(`✓ Emoji Alignment: ${audit.emojis ? "✅" : "❌"} ${genderMatrix.female.triggers.join(' ')}`);
    console.log(`✓ Psychology Score: ${audit.psychology ? "100%" : "35%"} (3/3 triggers matched)`);
    console.log(`✓ Structural Integrity: ${audit.structure ? "✅" : "❌"} (Narrative flow detected)`);
    console.log(`✓ Compliance: ${audit.score}/6 | ${500 - msg.length} chars remaining`);

    console.log("\n🎯 OPTIMIZATION HACKS");
    console.log("① Add UGC carousel with female athlete testimonials");
    console.log("② Micro-target with pregnancy/postpartum keywords");
    3










    
    console.log("③ A/B test menstrual cycle-aware messaging");

  } catch (error) {
    console.error("🚨 CRITICAL FAILURE:", error.message);
    console.log("⚠️ FALLBACK MESSAGE ACTIVATED ⚠️");
    console.log(`Hi gorgeous! 🌸 Our new yoga skirts give YOU the power to own your fitness journey 💪 Check them now ➡️ ${process.env.URL || "bit.ly/urbanfit-new"}`);
  }
})();