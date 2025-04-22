// server.js
import 'dotenv/config.js';
import express   from 'express';
import OpenAI    from 'openai';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());  // 加载 stealth 插件

const app = express();
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sleep  = ms => new Promise(r => setTimeout(r, ms));

let browser;
let page;

// 只在第一次调用时 connect (复用已有 Chrome)
async function initBrowser() {
  if (browser) return;
  browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  page = (await browser.pages())[0];
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/116.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width:1280, height:800 });
}

// 核心流程，progress 用于 SSE 推送日志
async function runSearchReport(query, progress) {
  await initBrowser();
  progress({ step: ' 已连接到现有 Chrome' });

  const functions = [
    { name:'navigate', description:'Go to a URL',
      parameters:{ type:'object', properties:{ url:{type:'string'} }, required:['url'] }
    },
    { name:'type',     description:'Type text',
      parameters:{ type:'object', properties:{ text:{type:'string'} }, required:['text'] }
    },
    { name:'pressKey', description:'Press a key',
      parameters:{ type:'object', properties:{ key:{type:'string'} }, required:['key'] }
    }
  ];

  const steps = [
    { instr:'Open https://www.google.com',             fn:'navigate', argKey:'url',  argVal:'https://www.google.com' },
    { instr:`Type "${query}" into the search box`,     fn:'type',     argKey:'text', argVal: query },
    { instr:'Press Enter to perform the search',       fn:'pressKey', argKey:'key',  argVal:'Enter' }
  ];

  for (let i=0; i<steps.length; i++) {
    const { instr, fn, argKey, argVal } = steps[i];
    progress({ step: `Step ${i+1}: ${instr}` });

    const buf  = await page.screenshot();
    const b64  = buf.toString('base64');
    progress({ step: '  → 截取屏幕' });

    progress({ step: '  → 调用模型决定动作' });
    const chat = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages:[
        { role:'system', content:'You are a GUI automation assistant.' },
        {
          role:'user',
          content:`Here is the screenshot. ${instr}`,
          attachments:[{ filename:'screen.png', mimeType:'image/png', data:b64 }]
        }
      ],
      functions,
      function_call:'auto'
    });

    const msg = chat.choices[0].message;
    let name,args;
    if (msg.function_call) {
      name = msg.function_call.name;
      args = JSON.parse(msg.function_call.arguments);
      progress({ step: ` 模型调用: ${name} ${JSON.stringify(args)}` });
    } else {
      progress({ step: `模型未返回，回退执行 ${fn}` });
      name = fn;
      args = { [argKey]: argVal };
    }

    if (name === 'navigate') {
      await page.goto(args.url, { waitUntil:'networkidle2' });
    } else if (name === 'type') {
      await page.keyboard.type(args.text);
    } else if (name === 'pressKey') {
      const key = args.key.charAt(0).toUpperCase() + args.key.slice(1).toLowerCase();
      await page.keyboard.press(key);
    }
    await sleep(800);
  }

  progress({ step:' 提取前 3 条搜索结果' });
  await page.waitForSelector('h3');
  const results = await page.$$eval('h3', hs=>
    hs.slice(0,3).map(h3=>{
      const a=h3.closest('a');
      return { title:h3.innerText, url:a?.href||'' };
    })
  );

  const pages = [];
  for (const { title, url } of results) {
    if (!url) continue;
    progress({ step:` 访问 ${url}` });
    await page.goto(url, { waitUntil:'networkidle2' });
    await sleep(1000);
    const snippet = await page.evaluate(()=>document.body.innerText.slice(0,2000));
    pages.push({ title, url, snippet });
  }

  progress({ step:' 生成总结报告' });
  const prompt = pages.map((p,i)=>`【${i+1}】${p.title}\n${p.url}\n${p.snippet}`).join('\n\n');
  const summaryRes = await openai.chat.completions.create({
    model:'gpt-4o',
    messages:[
      { role:'system', content:'你是一名行业分析师。' },
      { role:'user',   content:`请根据以下内容撰写报告：\n\n${prompt}` }
    ]
  });

  return [pages, summaryRes.choices[0].message.content.trim()];
}

// SSE endpoint
app.get('/api/search/stream', async (req, res) => {
  const q = req.query.query;
  if (!q) return res.status(400).end();
  res.writeHead(200,{
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    Connection:'keep-alive'
  });
  const send = evt=>res.write(`data: ${JSON.stringify(evt)}\n\n`);
  try {
    const [ , report ] = await runSearchReport(q, send);
    send({ done:true, report });
  } catch (err) {
    send({ error: err.message });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(` Server listening on http://localhost:${PORT}`));

