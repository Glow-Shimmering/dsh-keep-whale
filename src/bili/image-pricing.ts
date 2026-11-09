/**
 * Provider-owned pricing has priority. The fallback is a bounded estimate for
 * exactly the documented DeepSeek Flash model names, not a verification that a
 * third-party gateway really routes the named model or invoices by this rule.
 *
 * Official visual-token description, checked 2026-11-09:
 * https://api-docs.deepseek.com/zh-cn/guides/vision/
 * https://api-docs.deepseek.com/updates/ (2026-09-10, Flash -> V4.1 Flash)
 * The fallback expires 2026-12-08 UTC as a local review policy; the official
 * documentation does not assert an expiry. Actual provider usage is still
 * authoritative and an unknown/overrun settlement stops further B 站 calls.
 */
export interface ImagePrice { visualTokens:number; text:string }
export interface ImagePricing {
  priceImages(images:readonly unknown[]):readonly ImagePrice[];
  source:'host'|'deepseek-official';
}
type PricingRoute = {provider:string;model:string};
const VALID_UNTIL=Date.parse('2026-12-08T00:00:00Z');
const DOCUMENTED_FLASH_IDS=new Set(['deepseek-flash','DeepSeek-V4.1-Flash']);

export function resolvedImagePricing(llm:any,route:PricingRoute,now=Date.now()):ImagePricing|undefined {
  if(!route || typeof route.provider!=='string' || !route.provider.trim() || typeof route.model!=='string' || !route.model.trim())return undefined;
  const host=typeof llm?.imageRequestPricing==='function'?llm.imageRequestPricing(route.provider,route.model):undefined;
  if(typeof host?.priceImages==='function')return {source:'host',priceImages:(images)=>host.priceImages(images)};
  if(!Number.isFinite(now)||now>=VALID_UNTIL||!DOCUMENTED_FLASH_IDS.has(route.model))return undefined;
  return {source:'deepseek-official',priceImages:(images)=>images.map(image=>{
    const attachment=(image as {attachment?:unknown})?.attachment;
    if(!attachment || typeof attachment!=='object')throw new Error('图片附件信息无效');
    const text=JSON.stringify(attachment);
    if(typeof text!=='string')throw new Error('图片附件信息无效');
    return {visualTokens:1024,text};
  })};
}
