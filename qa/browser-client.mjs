import { writeFileSync } from 'node:fs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export class DevTools {
  constructor(ws){this.ws=ws;this.sequence=0;this.pending=new Map();this.errors=[];
    ws.addEventListener('message',event=>{const message=JSON.parse(event.data);const pending=this.pending.get(message.id);
      if(pending){this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.result);}
      if(message.method==='Runtime.exceptionThrown')this.errors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
    });
  }
  static async connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});return new DevTools(ws);}
  send(method,params={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`DevTools timeout: ${method}`));},15000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;}
  async waitFor(expression,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await this.evaluate(expression))return;await delay(100);}throw new Error(`browser state timeout: ${expression}`);}
  async screenshot(path,{fullPage=true}={}){const params={format:'png',captureBeyondViewport:fullPage};if(fullPage){const {cssContentSize}=await this.send('Page.getLayoutMetrics');params.clip={x:0,y:0,width:cssContentSize.width,height:cssContentSize.height,scale:1};}const result=await this.send('Page.captureScreenshot',params);writeFileSync(path,Buffer.from(result.data,'base64'));}
  async click(selector){const point=await this.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing click target');e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await this.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});}
  close(){this.ws.close();}
}
