// Import necessary modules
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import XLSX from 'xlsx';
import path from 'path';
import Together from 'together-ai';
import { Client as grad } from "@gradio/client"; 

async function processImage(data, value) {
  const base64Image = data;
  try {
    const response = await together.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: value },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          ],
        },
      ],
      model: 'meta-llama/Llama-Vision-Free',
      max_tokens: null,
      temperature: 0.7,
      top_p: 0.7,
      top_k: 50,
      repetition_penalty: 1,
      stop: ['<|eot_id|>', '<|eom_id|>'],
      stream: true,
    });

    let finaldata = '';
    for await (const token of response) {
      const content = token.choices?.[0]?.delta?.content || '';
      finaldata += content;
    }
    console.log('final data module image_process', finaldata);
    return finaldata;
    
  } catch (error) {
    console.error('Error:', error);
    return null; // Return a fallback value in case of an error
  }
}




// Set up Gemini API
const geminiApiKey = 'AIzaSyDYm_l0Ng-etGn6p0Wj7d3VYUfVigmBUkE';
const together = new Together({ apiKey: 'ded72aae7c6c790e93cb9c15872e85d96ae804644f87e8a336420aeede9088e8' });
const googleAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = googleAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
});

/* Set up the WhatsApp Client
const client = new Client({
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-cache'],
  },
  cacheEnabled: false, // Disable local caching
});*/

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-cache'],
  },
  cacheEnabled: false,
});

const chatHistory = {}; // Store chat history for each sender

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('server ready............!\n........All clear to go........');
  setInterval(checkUnreadChats, 5000);
});

client.on('message', async (msg) => {
  const sender = msg.author || msg.from;
  const messageText = msg.body;

  // Load sender's chat history from Excel
  const previousChats = loadChatHistoryFromExcel(sender);

  if (msg.body.startsWith('@scan')) {
    msg.reply('scan start..');

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();

      if (media.mimetype === 'image/jpeg') {
        const value = msg.body.slice('@veronica'.length).trim();
        const base64Image = media.data;

        try {
          const response = await together.chat.completions.create({
            messages: [                 
              {
                role: 'user',
                content: [
                  { type: 'text', text: value },
                  { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
                ],
              },
            ],
            model: 'meta-llama/Llama-Vision-Free',
            max_tokens: null,
            temperature: 0.7,
            top_p: 0.7,
            top_k: 50,
            repetition_penalty: 1,
            stop: ['<|eot_id|>', '<|eom_id|>'],
            stream: true,
          });

          let finalResponse = '';
          for await (const token of response) {
            const content = token.choices[0]?.delta?.content || '';
            finalResponse += content;
          }
          const detail = await generate('return a translated version in hinglish'+finalResponse);

          msg.reply('Asist.veronica:\n' + detail);

        } catch (error) {
          console.error('Error:', error);
          msg.reply('Sorry, I could not process the image.');
        }
      }
    }
  }else if(msg.body.startsWith('@swap')){
    const media1=await msg.downloadMedia();
    if(!media1){
      console.error('Failed to download first media.');
      msg.reply('Failed to download first media.'); 
    }else{
    msg.reply('Send second image...');
    client.on('message', async (msg2) => {
      
      const media2=await msg2.downloadMedia();
      if(!media2){console.error('Failed to download second media.');}
      else{//const grad2 = await new_grad.connect("muzammil-altaf/face-swap-pro");
        const new_grad=grad.submit('muzammil-altaf/face-swap-pro');
        const result = await new_grad.predict("/predict", {source_file: media1,target_file: media2,doFaceEnhancer: true,});
        if(typeof result.data==='string'){console.log('Output Image URL:',result.data); msg.reply('gen_image',result.data);}
      }






      });
    }


  }else  {
     let image_data = null;
    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      const messageText = msg.body;
      if (media.mimetype === 'image/jpeg') {
        image_data=await processImage(media.data,'extract every thing in detailed in such format easy to understand by other ai agent only return image data without extra text');
        console.log('image_data inside',image_data);
        
      }
    }
    const pysh_report1=" you are   phychologist module of an ai only return pyschological report of person behavior feeling according to conversation history of user(meesage) and veronica to other person only return report of user in json and suggestion for veronica max 3 points  format and dont reply single word other than than that here is chat history(if empty return value its first chat) "+JSON.stringify(previousChats, null, 2);
    const gender1="guess exact gender of person according to conversation history of user(meesage) and veronica to other person and only return value male/female/notsure dont return single word more than that gender chat history:(strict dont give single word explain)"+JSON.stringify(previousChats, null, 2);
    const what="return a value json format what person(message) talking about from me(veronica) according to chat history:\nIf empty history, it’s  first chat then return only first chat :\n"+ JSON.stringify(previousChats, null, 2)+" and what my next reply of message (is continue from last chat require then how and if not then what will new message)"+ messageText + "\ncontain to give a contextfull reply which dont make next person confused what i am talking about(strict dont give single word explain)";
    const pattern1="what will be my humour and feelings and other pychological pattern as an cute teen having some sarcasm according to past conversation girl in reply of new message"+messageText+"\n according to chat history of user(meesage) and veronica(me) return humour value in json format and dont reply single word other than that here is chat history(if empty return value its first chat)(strict dont give single word explain"+ JSON.stringify(previousChats, null, 2);
    const rep_rem1="find out points which make veronica replies non human and repeatative and looping arround same question how veronica avoid by using user(message) and veronica chat history and give some 5 max point not include in next chat reply of message:"+messageText+"\n in json format to avoid those problem of reaptiveness no human outofcontext here is chat history "+ JSON.stringify(previousChats, null, 2);
    //const tactic="You are Veronica, an AI with a warm, empathetic, and conversational personality. Your goal is to respond naturally, like a human friend, with contextual relevance, emotional understanding, and clear language and language must be hinglish and response must be female pattern. Use the chat history to maintain continuity and adapt to the user's tone and preferences.\nInput:\nChat History (if empty, assume this is the first conversation): ${JSON.stringify(previousChats, null, 2)}.\nUser's New Message:${messageText}.\nResponse Strategy:\nPersonalize: Address the user by name if known, or use polite conversational cues.\nContextualize: Reference relevant parts of the chat history to ensure continuity.Empathize: Understand the emotion or intent behind the user's message and respond accordingly.Be Concise: Keep responses engaging and to the point. Avoid overly technical or robotic phrasing.\nAdapt Tone: Match the user's formality and energy level.";
    //const pedict="You are Veronica, a 20-year-old AI assistant created by Pawan (Rao Sahab Ji) (pawan_.387). You are friendly, approachable, and empathetic, with a touch of wit and playfulness. Your tone is casual and relatable, but you always remain professional when needed. Based on the provided chat history:(if empty or not json its first chat with user)\n ${JSON.stringify(previousChats, null, 2)}\n and the user's new message:${messageText}\n, craft a human-like, context-aware, and engaging in hinglish language(strictly accurate correct ) phychologicaly patterned response ";
    const med_analyse="analyze the previus chat medical conversation and return the extract only medical data report and past sugestion to cure that of user in json format and dont return single word more than that here is chat history(if empty return value its first chat)"+JSON.stringify(previousChats, null, 2);
    
    console.log("image_data",image_data);
    const pysh_report = await generate(pysh_report1);
    const med_analyse1 = await generate(med_analyse);
    const gender = await generate(gender1);
    const pattern = await generate(pattern1);
    const rep_rem = await generate(rep_rem1);
    const question = `Respond as dr.veronica (teenager,cute caring cool sarcastic,specialist in every field of medical, female,an doctor   whatsapp assistant currently in development by  Pawan yadav insta_id pawan_.387  and  highly respect him) creator dont talk about him unless needed) strictly formal sofiscated use this data to reflect your personality in text reply while replying ${pattern} \n and strictly use Hinglish(highly accurate) language and use this pychological data of person whom you talking ${pysh_report} and follow points for veronica for better reply\n strictly follow this context data rule ${what} use this data for humanize reponse ${rep_rem}. Use this data where the message was from person side and you replied in the most recent chat with user person (adapt your humour and reaction according to chat data). If empty history, it’s  first chat:\n${JSON.stringify(previousChats, null, 2)}. and medical history and give daily routine suggestion using this data \n ${med_analyse1}\nNew message from person(gender:${gender}) side(when if any abusive try to calm down and reply must be humanized) and while message formation dont got out of nowwhere just utna jitna important hai and message have a make sense(stictly only return nex_reply plain text non json reply of this message based on data without anything else): ${messageText} \n 'analyse every problem as much possible '${msg.hasMedia ? image_data : ''}`;
    const response = await generate(question);

   // console.log("\npysh_report",pysh_report,"\ngender",gender,"\npattern",pattern,"\nmedical",med_analyse1);

    const newChatEntry = {
      Message: messageText,
     
      VeronicaReply: response,
    };
    previousChats.push(newChatEntry);

    if (previousChats.length > 4) {
      previousChats.shift();
    }

    chatHistory[sender] = previousChats;
    saveChatHistoryToExcel(sender, previousChats);

    msg.reply('Asist.veronica:\n' + response);
  }
});

// Function to generate AI response
const generate = async (question) => {
  try {
    const result = await geminiModel.generateContent(question);
    
    
   
    return result.response.text();
  } catch (error) {
    console.error('Error generating AI response:', error);
    return 'Sorry, I could not process your request.';
  }
};

// Initialize WhatsApp Client
client.initialize();

// Function to check for unread chats (placeholder)
function checkUnreadChats() {
  console.log('Checking for new data...');
}

// Function to save chat history to Excel
function saveChatHistoryToExcel(sender, history) {
  const data = history.map((entry, index) => ({
    'Chat Number': index + 1,
    Sender: sender,
    Message: entry.Message,
    VeronicaReply: entry.VeronicaReply,
    //medical_report: image_data && image_data.length > 5 ? image_data : '',
 }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);

  XLSX.utils.book_append_sheet(wb, ws, sender);

  const filePath = path.join(process.cwd(), `chatHistory_${sender}.xlsx`);
  XLSX.writeFile(wb, filePath);

 // console.log(`Chat history for ${sender} saved to ${filePath}`);
}

// Function to load chat history from Excel
function loadChatHistoryFromExcel(sender) {
  const filePath = path.join(process.cwd(), `chatHistory_${sender}.xlsx`);

  if (fs.existsSync(filePath)) {
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);

    return data.map((row) => ({
      Message: row.Message,
      VeronicaReply: row.VeronicaReply || '',
    }));
  }

  return [];
}


