


import express from 'express';
import { getAudioUrl } from 'uberduck-api';


const { ChatGPTAPI, getOpenAIAuth } = require('./utils/chatgpt/build/index');


//we need to get body from request
import bodyParser from 'body-parser';
//we need to parse body from request


let api: typeof ChatGPTAPI;

require('dotenv').config();


((async () => {
  const openAIAuth = await getOpenAIAuth({
    email: process.env.USER,
    password: process.env.PASS
  })

  api = new ChatGPTAPI({ ...openAIAuth, markdown: false })
}))()


const app = express();


app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


//env variables

//get secret key from .env file
const secret = process.env.SECRET || '';
const key = process.env.KEY || '';



async function getAudioUrlFromText(text: string) {

  const audio = await getAudioUrl(key, secret, 'mario-sports-mix', text).catch((err) => {
    console.log(err);
  });
  return audio;
}

app.get('/', (req, res) => {
  res.send('Hello, world!');
});

app.post('/text-to-chat', async (req, res) => {
  const text = req.body.text;
  const audioUrl = await getAudioUrlFromText(text);
  res.send(audioUrl);

});

app.post('/chat-gpt-text', async (req, res) => {
  const text = req.body.text;
  await api.ensureAuth();
  const response = await api.sendMessage(text);
  res.send(response);

})

app.post('/chat-gpt-audio', async (req, res) => {
  const text = req.body.text;
  await api.ensureAuth();
  const response = await api.sendMessage(text);
  //console.log("response: ", response)
  //check character length >Greater than 100 characters split
  //strip grammer and punctuation

  //remove first line of text
  let stripped = response.replace(/^.*\n/, "");
  // stripped = stripped.replace(/[^a-zA-Z]/g, "");
  stripped = stripped.replace(/^(.*?)\:/gm, " ");

  stripped = stripped.replace(/\n\r*/g, "");
  console.log("stripped: ", stripped)

  const audioUrl = await getAudioUrlFromText(stripped);
  res.send(audioUrl);

});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
})