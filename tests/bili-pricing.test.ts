import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvedImagePricing } from '../src/bili/image-pricing.js';

const route={provider:'synthetic-gateway',model:'DeepSeek-V4.1-Flash'};
const now=Date.parse('2026-11-09T00:00:00Z');
const image={type:'image',attachment:{attachmentId:'synthetic-image',mediaType:'image/jpeg',bytes:100,width:10,height:10}};

test('host owned pricing takes precedence and retains the receiver',()=>{
  const pricing={factor:32,priceImages(images:readonly unknown[]){return images.map(()=>({visualTokens:this.factor,text:'host-handle'}));}};
  let got:unknown[]=[];
  const llm={imageRequestPricing(provider:string,model:string){got=[provider,model];return pricing;}};
  const result=resolvedImagePricing(llm,route,now);
  assert.equal(result?.source,'host');assert.deepEqual(got,[route.provider,route.model]);
  assert.deepEqual(result?.priceImages([image]),[{visualTokens:32,text:'host-handle'}]);
  assert.equal(resolvedImagePricing(llm,route,Date.parse('2027-01-01T00:00:00Z'))?.source,'host');
});

test('documented exact model names have time-bounded 1024-token estimate per image',()=>{
  for(const model of ['DeepSeek-V4.1-Flash','deepseek-flash']){
    const result=resolvedImagePricing({imageRequestPricing:()=>undefined},{provider:'synthetic-gateway',model},now);
    assert.equal(result?.source,'deepseek-official');
    const prices=result!.priceImages([image,image]);assert.equal(prices.length,2);
    assert.ok(prices.every(p=>p.visualTokens===1024&&p.text===JSON.stringify(image.attachment)));
  }
  assert.equal(resolvedImagePricing({},route,Date.parse('2026-12-08T00:00:00Z')),undefined);
  assert.ok(resolvedImagePricing({},route,Date.parse('2026-12-07T23:59:59.999Z')));
  assert.equal(resolvedImagePricing({},route,NaN),undefined);
});

test('other routes are not guessed and malformed attachments cannot produce a false bound',()=>{
  for(const model of ['deepseek-v4-flash','deepseek-flash-pro','DeepSeek-V4.1-Flash-Max','deepseek-v4.1-flash','unknown'])assert.equal(resolvedImagePricing({}, {provider:'synthetic-gateway',model},now),undefined);
  assert.equal(resolvedImagePricing({}, {provider:'',model:route.model},now),undefined);
  assert.throws(()=>resolvedImagePricing({},route,now)!.priceImages([{type:'image'}]),/附件/);
});
