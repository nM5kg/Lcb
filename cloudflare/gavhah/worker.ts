/**
 * Independent full Cloudflare Gavhah application: original Express API and
 * React SPA static assets live in ONE Cloudflare Worker. No Render proxy.
 * Uses the existing Neon PostgreSQL database with Worker runtime secrets.
 * Real phone callbacks require provider-secret and number verification.
 */
import {httpServerHandler} from "cloudflare:node";
import app from "../../artifacts/api-server/src/app-cloudflare";
import {inlineAssets} from "./generated-static-assets";

const api=httpServerHandler({port:8787});
// Start the Express server at module load (as before) and let API requests
// wait until it is listening. Starting it lazily inside fetch made some
// fresh isolates answer with a dropped connection: the runtime cancels a
// request in milliseconds when the local Node server it is forwarded to is
// not yet up, which surfaced as "Connection error" / 1101 in the browser.
const listeningPromise: Promise<void> = new Promise<void>((resolve, reject) => {
  try {
    const server = app.listen(8787, () => resolve());
    server.on("error", reject);
  } catch (err) {
    reject(err);
  }
});
function ensureListening(): Promise<void> {
  return listeningPromise;
}
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const mimeCache="public, max-age=600";
function nativeReadiness(env:Record<string,unknown>){
 const dbUrl=String(env.DATABASE_URL||"");
 let databaseCredentialPresent=false;
 try{
  const parsed=new URL(dbUrl);
  databaseCredentialPresent=(parsed.protocol==="postgresql:"||parsed.protocol==="postgres:")&&
   parsed.hostname.endsWith(".neon.tech")&&!!parsed.username&&!!parsed.password;
 }catch{}
 const sessionsConfigured=String(env.SESSION_STORE||"")==="postgres"&&
  String(env.SESSION_COOKIE_SECURE||"")==="true"&&
  String(env.SESSION_SECRET||"").length>=32;
 const encryptedProviderKey=String(env.YEMOT_ENCRYPTION_KEY||"");
 const providerCryptographyConfigured=encryptedProviderKey.length>=40&&
  encryptedProviderKey!=="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
 const webhookSigningConfigured=String(env.SIGNALWIRE_SIGNING_KEY||"").length>=24;
 // Yemot must never depend on SignalWire credentials or routes.
 const yemotOperatorEnabled=String(env.CF_YEMOT_WEBHOOKS_ENABLED||"")==="true";
 const signalwireOperatorEnabled=String(env.CF_PHONE_WEBHOOKS_ENABLED||"")==="true";
 const yemotPhoneCallbacksEnabled=databaseCredentialPresent&&sessionsConfigured&&
  providerCryptographyConfigured&&yemotOperatorEnabled;
 const signalwirePhoneCallbacksEnabled=databaseCredentialPresent&&sessionsConfigured&&
  webhookSigningConfigured&&signalwireOperatorEnabled;
 const phoneCallbacksEnabled=yemotPhoneCallbacksEnabled&&signalwirePhoneCallbacksEnabled;
 return {databaseCredentialPresent,sessionsConfigured,phoneCallbacksEnabled,
  yemotPhoneCallbacksEnabled,signalwirePhoneCallbacksEnabled};
}
function paused(message:string,status=503){
 return Response.json({status:"staging",message},{status,headers:{"Cache-Control":"no-store"}});
}
export default {
 async fetch(request:Request,env:unknown,ctx:unknown):Promise<Response>{
  const url=new URL(request.url);
  const values=env as Record<string,unknown>;
  const readiness=nativeReadiness(values);
  if(url.pathname==="/__gavhah/status"&&request.method==="GET"){
   return Response.json({
    hosting:"cloudflare-native",
    renderProxy:false,
    databaseCredentialsConfigured:readiness.databaseCredentialPresent,
    sessionsConfigured:readiness.sessionsConfigured,
    phoneCallbacksEnabled:readiness.phoneCallbacksEnabled,
    yemotPhoneCallbacksEnabled:readiness.yemotPhoneCallbacksEnabled,
    signalwirePhoneCallbacksEnabled:readiness.signalwirePhoneCallbacksEnabled,
    databaseReachabilityVerified:false,
    livePhoneNumberTransferred:false
   },{headers:{"Cache-Control":"no-store"}});
  }
  if(url.pathname==="/api"||url.pathname.startsWith("/api/")){
   if(!readiness.databaseCredentialPresent||!readiness.sessionsConfigured)
    return paused("Independent Cloudflare backend is awaiting its Neon and session configuration.");
   const path=url.pathname;
   if(path.startsWith("/api/yemot/")&&!readiness.yemotPhoneCallbacksEnabled)
    return paused("Yemot callback is not yet activated on Cloudflare; existing provider routing remains unchanged.");
   if(path.startsWith("/api/signalwire/")&&!readiness.signalwirePhoneCallbacksEnabled)
    return paused("Legacy SignalWire callback is locked; this has no effect on Yemot.");
   if(path.startsWith("/api/admin/hotline-migration")&&
    !["GET","HEAD","OPTIONS"].includes(request.method))
    return paused("Shared live phone-provider administration is locked on the independent Cloudflare copy.",403);
   // Never let an API request die with a dropped connection: wait until the
   // Node server is listening, and answer every failure as JSON so the
   // frontend can retry instead of showing a generic connection error.
   try {
    await withTimeout(ensureListening(), 8000, "Server startup timed out");
    // Safety net: if the Node server ever truly stalls, answer JSON 503
    // after 25s (which the frontend retries) instead of letting the runtime
    // cancel the request as a "hung" 1101. A pending timer also keeps the
    // request's event loop alive while the server works.
    const guard = new Promise<Response>((resolve) => {
      setTimeout(() => resolve(Response.json({error:"Service temporarily unavailable. Please try again."},{status:503,headers:{"Cache-Control":"no-store"}})), 25_000);
    });
    const res = await Promise.race([api.fetch(request,env,ctx), guard]);
    return res;
   } catch (err) {
    console.error("Gavhah Cloudflare API", "API proxy failed", err instanceof Error ? err.message : "error");
    return Response.json({error:"Service temporarily unavailable. Please try again."},{status:503,headers:{"Cache-Control":"no-store"}});
   }
  }
  if(request.method!=="GET"&&request.method!=="HEAD")
   return new Response("Method not allowed",{status:405,headers:{Allow:"GET, HEAD"}});
  const path=url.pathname;
  const file=inlineAssets[path] || (path.startsWith("/assets/")?undefined:inlineAssets["/index.html"]);
  if(!file)return new Response("Not found",{status:404});
  // Build output is gzip-compressed and inlined into the Worker script itself;
  // no Cloudflare Pages, Render, CDN, or separate assets upload is required.
  const raw=atob(file.base64);
  const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  // Decode the embedded asset before sending. Cloudflare handles HTTP compression.
  const headers=new Headers({
    "Content-Type":file.mime,
    "Cache-Control":path.startsWith("/assets/")?mimeCache:"no-store",
    "X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"strict-origin-when-cross-origin",
    "Vary":"Accept-Encoding"
  });
  const body=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(request.method==="HEAD"?null:body,{status:200,headers});
 }
};
