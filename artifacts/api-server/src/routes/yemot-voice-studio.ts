import {Router, type Request, type Response} from "express";
import {randomUUID, createDecipheriv} from "node:crypto";
import {pool} from "@workspace/db";
import {requireAuth, getCurrentSessionUser} from "../middlewares/auth";
import {phoneTree,phonePrompt} from "./yemot-whole-platform-ivr";
import {sectionPaths} from "../lib/yemot-section-batch1";
import {gavhahPhoneStageVoices} from "../lib/gavhah-phone-voice-stages";
import {yemotStudioUI} from "./yemot-studio-ui";
import {sharedVoiceChangerBrowserSource} from "./voice-changer-browser";

// Only the already approved Gavhah/Yemot connection is used. Never change
// the root extension, switch numbers, or use SignalWire for this feature.
const router=Router();
const dbTable="public.gavhah_yemot_voice_prompts";
export const safePath=(x:string)=>x==="root"||/^[1-9][0-9]{0,15}[a-z]?$/.test(x);
const problem=(res:Response,code:number,error:string)=>res.status(code).json({error});
const sameOrigin=(req:Request)=>{
 const origin=req.get("origin");
 if(req.get("sec-fetch-site")==="cross-site"||req.get("sec-fetch-site")==="same-site")return false;
 if(!origin)return true;
 try{
  const host=req.get("x-forwarded-host")||req.get("host");
  const url=new URL(origin);
  return url.protocol==="https:"&&url.host===host;
 }catch{return false;}
};
async function admin(req:Request,res:Response,next:(error?:unknown)=>void){
 try{
  const user=await getCurrentSessionUser(req);
  if(!user||user.role!=="super_admin"){problem(res,403,"Super administrator only");return;}
  if(req.method!=="GET"&&!sameOrigin(req)){problem(res,403,"Same-origin only");return;}
  next();
 }catch(e){next(e);}
}
function wrap(fn:(req:Request,res:Response)=>Promise<void>){
 return (req:Request,res:Response,next:(error?:unknown)=>void)=>{void fn(req,res).catch(next);};
}
type TreeItem={label:string;children?:Record<string,TreeItem>};
function catalogue(){
 const items:{path:string,label:string,kind:string,depth:number,parent:string,displayDigit?:string}[]=[
  {path:"root",label:"Main menu — Gavhah / Campaign Center",kind:"menu",depth:0,parent:""}
 ];
 const visit=(tree:Record<string,TreeItem>,prefix:string)=>{
  for(const [digit,item] of Object.entries(tree)){
   const path=prefix+digit;
   items.push({path,label:item.label,kind:item.children?"menu":"button",depth:path.length,parent:prefix||"root"});
   if(item.children)visit(item.children,path);
  }
 };
 visit(phoneTree as Record<string,TreeItem>,"");
 const nDigits:Record<string,string>={"111":"4","113":"1","114":"2","115":"3"};
 for(const item of items){if(nDigits[item.path]){item.parent="97111";item.depth=4;item.displayDigit=nDigits[item.path];item.label=nDigits[item.path]+" — "+item.label;}}
 items.push({path:"97111",label:"1 — Other news options",kind:"menu",depth:3,parent:"11",displayDigit:"1"});
 // Virtual menus reached by direct numbers (11–15, 77), not by phoneTree
 // digits. They have Yiddish prompts and must be editable in the studio.
 const virtualMenus:[string,string,string,string][]=[
  ["97181","2 — Notifications options","menu","12"],
  ["971811","1 — Unread notifications","button","97181"],
  ["971812","2 — All notifications","button","97181"],
  ["971813","3 — Mark all notifications read","button","97181"],
  ["971814","4 — Notifications by type","button","97181"],
  ["97190","1 — Search options","menu","11"],
  ["97193","3 — My connections options","menu","13"],
  ["9777","77 — More departments","menu","root"],
 ];
 for(const [path,label,kind,parent] of virtualMenus)
  if(!items.some(x=>x.path===path))items.push({path,label,kind,depth:path.length,parent});
 // Virtual gate (path 120): the login gate is reached by the engine, not
 // by phoneTree digits, so it needs a catalogue entry of its own — without
 // it knownPath("120")/knownPath("120a") fail and no gate recording can
 // ever be published via the studio. The gate prompts are recorded in
 // pinchas under keys 120a–120j (see true-menu.ts gateAudioKeyForState).
 items.push({path:"120",label:"Login gate — member password / member ID",kind:"menu",depth:3,parent:"root"});
 // Implementation != verified phone functionality: label honestly.
 const known=new Set([...sectionPaths,"155","166","167","173","111","1121","1122","1123","1124","1125","1126","1127","1128","1129","113","114","115","121","122","123","124","125","126","185"]);
 items.push(...Object.entries(gavhahPhoneStageVoices).map(([path,item])=>({path,label:item.label,kind:"button",depth:4,parent:path.slice(0,3)})));
 return items.map(item=>({...item,
  suggestedEnglish:item.path==="11"?"To hear all updates, stay on the line. For other options, press 1.":item.path==="97111"?"Other news options. Press 1 for important and critical news. Press 2 for featured updates. Press 3 to find an update by article number. Press 4 for all updates. Press star to go back.":gavhahPhoneStageVoices[item.path]?.text || (item.kind==="menu"?phonePrompt(item.path==="root"?"":item.path):
   "You selected "+item.label+". Press star to go back."),
  capability:item.kind==="menu"?"navigation":
  known.has(item.path)?"api_implemented_not_phone_verified":"roadmap_only"}));
}
export function knownPath(input:string){
 const paths=new Set(catalogue().map(x=>x.path));
 if(paths.has(input))return true;
 // Voice-prompt keys (1591a … 1592v) are not tree paths: accept a suffixed
 // key when its unsuffixed base is a known path (1591, 1592). Without
 // this, no Tishl/Calling draft could ever be published via the studio.
 const m=/^([1-9][0-9]{0,15})([a-z])$/.exec(input);
 return !!m&&paths.has(m[1]);
}
function getName(req:Request){return String(req.params.path||"");}
function checkAudio(bytes:Buffer,mime:string){
 if(bytes.length<80||bytes.length>4*1024*1024)return false;
 if(mime==="audio/wav"||mime==="audio/wave"||mime==="audio/x-wav")
  return bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WAVE";
 if(mime==="audio/webm")return bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
 if(mime==="audio/ogg")return bytes.toString("ascii",0,4)==="OggS";
 if(mime==="audio/mpeg"||mime==="audio/mp3")
  return bytes.toString("ascii",0,3)==="ID3"||(bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0);
 return false;
}
router.get("/admin/voice-changer.js",requireAuth,admin,(_req,res)=>{
 res.setHeader("Cache-Control","private, no-store");
 res.setHeader("X-Content-Type-Options","nosniff");
 res.type("application/javascript; charset=utf-8").send(sharedVoiceChangerBrowserSource);
});
router.get("/admin/yemot/voice-studio",requireAuth,admin,wrap(async(_req,res)=>{
 if(String(_req.query.data||"")!=="1"){
  res.setHeader("Cache-Control","private, no-store");
  res.type("text/html; charset=utf-8").send(yemotStudioUI);
  return;
 }
 const [prompts,installation,voiceFolder]=await Promise.all([
  pool.query("SELECT path,tts_text,tts_muted,mime_type,octet_length(audio_data) AS audio_size,published_path,published_at,updated_at,yiddish_text,voice,language,audio_version,previous_audio_version,pending_regeneration,pending_voice FROM "+dbTable+" ORDER BY path"),
  pool.query("SELECT state,target_path,provider_summary->>'apiEndpoint' AS recorded_endpoint,provider_summary #>> '{campaign4444,state}' AS campaign_state FROM public.gavhah_yemot_ivr_install WHERE id=1"),
  pool.query("SELECT media_folder FROM public.gavhah_yemot_voice_storage WHERE id=1")
 ]);
 res.setHeader("Cache-Control","private, no-store");
 const campaignReady=installation.rows[0]?.campaign_state==="live";
 const gavhahMain="Welcome to Gavhah. For news and updates, press 1. For My Askanus, press 2. For contacts, press 3. For calling, press 4. For kindness, press 5. For community, press 6. For minyans, press 7. For messages or registration, press 8. For management, press 9. For advanced Askanus keypad, enter 88 then pound. For Campaign Center, enter 4444. For official Gavhah member registration, press 0. Press star to go back.";
 const originalMain="Welcome to Gavhah and Campaign Center. For Gavhah, press 1. For Campaign Center, press 2. To create a website member account, press 8. For official Gavhah member registration, press 0. Press star to go back.";
 const items=catalogue().map(item=>({...item,
  effectiveTts:gavhahPhoneStageVoices[item.path]?.text || (item.path==="root"?(campaignReady?gavhahMain:originalMain):item.kind==="menu"?phonePrompt(item.path).replace(/press zero to go back/gi,"press star to go back"):item.suggestedEnglish),
  dynamic:item.kind!=="menu"}));
 res.json({catalogue:items,prompts:prompts.rows,
  provider: {state:installation.rows[0]?.state||"not_configured",
    approvedFolder:voiceFolder.rows[0]?.media_folder||null,
    recordedCallback:installation.rows[0]?.recorded_endpoint||null,
    cloudflareCallback:"https://"+(_req.get("x-forwarded-host")||_req.get("host")||"gavhah-cloudflare-native.gavhah-copy.workers.dev")+"/api/yemot/ivr",
    providerRouteVerifiedLive:false},
  note:"Draft audio is private. Only a manually published and verified file is offered to the existing Yemot IVR. No phone number, root menu, or SignalWire configuration is changed."});
}));
router.put("/admin/yemot/voice-studio/:path",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 const phrase=req.body?.ttsText;
 if(typeof phrase!=="string"||phrase.length>950||
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(phrase)){
  problem(res,400,"English TTS must contain at most 950 characters");return;
 }
 if(/[\u0590-\u05ff]/u.test(phrase)){problem(res,400,"Telephone TTS is currently English-only");return;}
 const normalized=phrase.replace(/\s+/g," ").trim();
 const q=await pool.query(
  "INSERT INTO "+dbTable+"(path,tts_text) VALUES($1,$2) ON CONFLICT(path) DO UPDATE SET tts_text=EXCLUDED.tts_text,updated_at=now() RETURNING path,tts_text,updated_at",
  [path,normalized]);
 await pool.query("UPDATE "+dbTable+" SET tts_muted=false WHERE path=$1",[path]);
 res.json({ok:true,prompt:q.rows[0],note:"TTS applies on the connected Yemot API callback; no provider menu has been altered."});
}));
// Reset only a custom TTS override. The automatic menu text becomes active again.
router.delete("/admin/yemot/voice-studio/:path/tts",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 if(req.body?.confirm!=="RESET_CUSTOM_TTS"){problem(res,400,"Confirm TTS reset");return;}
 await pool.query("UPDATE "+dbTable+" SET tts_text='',tts_muted=false,updated_at=now() WHERE path=$1",[path]);
 res.json({ok:true,defaultRestored:true});
}));
// Explicitly silence the spoken TTS of one extension, preserving its recordings.
router.put("/admin/yemot/voice-studio/:path/tts-muted",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 if(typeof req.body?.muted!=="boolean"||req.body?.confirm!=="SET_TTS_SILENCE"){problem(res,400,"Explicit TTS confirmation required");return;}
 await pool.query("INSERT INTO "+dbTable+"(path,tts_muted) VALUES($1,$2) ON CONFLICT(path) DO UPDATE SET tts_muted=EXCLUDED.tts_muted,updated_at=now()",[path,req.body.muted]);
 res.json({ok:true,ttsMuted:req.body.muted,recordingsUnchanged:true});
}));
// Yiddish menus: per-button Yiddish text, voice and language.
// Voices from GET https://yiddish.tools/api/v1/voices (2026-11-16): 19 built-in.
const YIDDISH_VOICES=["pinchas","rochel","nachman","gitty","shimi","blimy","berel","moishy","hershel","leiby","shloimy","zalmen","avrumi","yanky","mottel","duvid","lipa","reuven","itzik"];
const isYiddishVoice=(v:string)=>YIDDISH_VOICES.includes(v);
const yiddishToolsHeaders=()=>({
 "Authorization":"Bearer "+(process.env.YIDDISH_TOOLS_API_KEY||""),
 "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"});
// Store a new draft audio version; the previous draft is kept for rollback.
async function storeNewDraftVersion(path:string,bytes:Buffer,mime:string,voice:string):Promise<number>{
 const current=(await pool.query("SELECT audio_data,mime_type,audio_version,voice FROM "+dbTable+" WHERE path=$1",[path])).rows[0];
 const q=await pool.query("INSERT INTO "+dbTable+"(path,audio_data,mime_type,voice,audio_version,pending_regeneration,pending_voice) VALUES($1,$2,$3,$4,1,false,NULL) "+
  "ON CONFLICT(path) DO UPDATE SET audio_data=EXCLUDED.audio_data,mime_type=EXCLUDED.mime_type,voice=EXCLUDED.voice,audio_version="+dbTable+".audio_version+1,pending_regeneration=false,pending_voice=NULL,updated_at=now() RETURNING audio_version",
  [path,bytes,mime,voice]);
 if(current?.audio_data){
  await pool.query("UPDATE "+dbTable+" SET previous_audio_data=$2,previous_mime_type=$3,previous_audio_version=$4,previous_voice=$5 WHERE path=$1",
   [path,current.audio_data,current.mime_type,current.audio_version,current.voice||"pinchas"]);
 }
 return Number(q.rows[0]?.audio_version||1);
}
// Edit the Yiddish text of this button's phrase (Hebrew allowed).
router.put("/admin/yemot/voice-studio/:path/yiddish",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 const phrase=req.body?.yiddishText;
 if(typeof phrase!=="string"||phrase.length>950||
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(phrase)){
  problem(res,400,"Yiddish text must contain at most 950 characters");return;
 }
 const normalized=phrase.replace(/\s+/g," ").trim();
 await pool.query("INSERT INTO "+dbTable+"(path,yiddish_text) VALUES($1,$2) ON CONFLICT(path) DO UPDATE SET yiddish_text=EXCLUDED.yiddish_text,updated_at=now()",
  [path,normalized]);
 res.json({ok:true,path,yiddishText:normalized});
}));
// Switch this button between Yiddish audio and English TTS.
router.post("/admin/yemot/voice-studio/:path/language",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 const language=String(req.body?.language||"");
 if(req.body?.confirm!=="SET_MENU_LANGUAGE"||(language!=="yi"&&language!=="en")){
  problem(res,400,"Confirm language switch (yi or en)");return;
 }
 await pool.query("INSERT INTO "+dbTable+"(path,language) VALUES($1,$2) ON CONFLICT(path) DO UPDATE SET language=EXCLUDED.language,updated_at=now()",
  [path,language]);
 res.json({ok:true,path,language});
}));
// Change the voice for this button: regenerate its Yiddish audio.
// With YIDDISH_TOOLS_API_KEY set on the Worker, a generation is created and
// the UI polls it. Without the key the request is queued (pending) and a
// sync process generates the audio; the old audio stays live until the admin
// publishes the new version.
router.post("/admin/yemot/voice-studio/:path/regenerate",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 const voice=String(req.body?.voice||"pinchas").trim();
 if(req.body?.confirm!=="REGENERATE_YIDDISH_AUDIO"||!isYiddishVoice(voice)){
  problem(res,400,"Confirm regeneration with a valid Yiddish Tools voice");return;
 }
 const row=(await pool.query("SELECT yiddish_text FROM "+dbTable+" WHERE path=$1",[path])).rows[0];
 const text=String(row?.yiddish_text||"").trim();
 if(!text){problem(res,409,"Save a Yiddish text for this button first");return;}
 const key=process.env.YIDDISH_TOOLS_API_KEY||"";
 if(!key){
  await pool.query("INSERT INTO "+dbTable+"(path,pending_regeneration,pending_voice) VALUES($1,true,$2) ON CONFLICT(path) DO UPDATE SET pending_regeneration=true,pending_voice=EXCLUDED.pending_voice,updated_at=now()",
   [path,voice]);
  res.json({ok:true,queued:true,voice,needsApiKey:true,note:"Regeneration queued. A sync process generates the new audio; the old audio stays live until the admin publishes the new version."});
  return;
 }
 const form=new URLSearchParams({text,voice});
 const created=await fetch("https://yiddish.tools/api/v1/speech",{method:"POST",
  headers:{...yiddishToolsHeaders(),"Content-Type":"application/x-www-form-urlencoded"},
  body:form,redirect: "manual",cache:"no-store",signal:AbortSignal.timeout(20000)});
 if(!created.ok){problem(res,502,"Yiddish Tools did not accept the regeneration");return;}
 const payload=await created.json() as {data?:{id?:string}};
 const generationId=String(payload?.data?.id||"");
 if(!/^[A-Za-z0-9_-]{8,64}$/.test(generationId)){problem(res,502,"Yiddish Tools returned no generation id");return;}
 res.json({ok:true,queued:false,generationId,status:"pending",voice,
  pollUrl:"/api/admin/yemot/voice-studio/"+encodeURIComponent(path)+"/regeneration/"+generationId});
}));
// Poll a Yiddish Tools generation; when completed, store it as the new draft
// version (old audio kept for rollback) and clear the pending flag.
router.get("/admin/yemot/voice-studio/:path/regeneration/:generationId",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 const generationId=String(req.params.generationId||"");
 if(!/^[A-Za-z0-9_-]{8,64}$/.test(generationId)){problem(res,400,"Invalid generation id");return;}
 const key=process.env.YIDDISH_TOOLS_API_KEY||"";
 if(!key){problem(res,409,"Yiddish Tools API key is not configured on this Worker");return;}
 const voice=String((await pool.query("SELECT pending_voice,voice FROM "+dbTable+" WHERE path=$1",[path])).rows[0]?.pending_voice||"pinchas");
 const checked=await fetch("https://yiddish.tools/api/v1/generations/"+generationId,{headers:yiddishToolsHeaders(),redirect: "manual",cache:"no-store",signal:AbortSignal.timeout(20000)});
 if(!checked.ok){problem(res,502,"Could not check the generation");return;}
 const gen=await checked.json() as {data?:{status?:string;files?:{audio?:string};credits_used?:number;error?:string}};
 const state=String(gen?.data?.status||"");
 if(state==="completed"){
  const audioUrl=String(gen?.data?.files?.audio||"");
  if(!audioUrl){problem(res,502,"Generation completed without an audio file");return;}
  const audio=await fetch(audioUrl,{headers:yiddishToolsHeaders(),redirect: "manual",cache:"no-store",signal:AbortSignal.timeout(30000)});
  if(!audio.ok){problem(res,502,"Could not download the generated audio");return;}
  const bytes=Buffer.from(await audio.arrayBuffer());
  if(bytes.length<80||bytes.length>4*1024*1024){problem(res,502,"Generated audio has an unexpected size");return;}
  const version=await storeNewDraftVersion(path,bytes,"audio/mpeg",voice);
  res.json({ok:true,stored:true,audioVersion:version,voice,creditsUsed:gen?.data?.credits_used??null});
  return;
 }
 if(state==="failed"||state==="error"){res.json({ok:false,status:state,error:gen?.data?.error||"Generation failed"});return;}
 res.json({ok:true,status:"processing"});
}));
// Restore the previous draft audio version (rollback).
router.post("/admin/yemot/voice-studio/:path/rollback",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 if(req.body?.confirm!=="ROLLBACK_YIDDISH_AUDIO"){problem(res,400,"Confirm rollback");return;}
 const r=await pool.query("UPDATE "+dbTable+" SET audio_data=previous_audio_data,mime_type=previous_mime_type,audio_version=previous_audio_version,voice=previous_voice,previous_audio_data=NULL,previous_mime_type=NULL,previous_audio_version=NULL,previous_voice=NULL,pending_regeneration=false,pending_voice=NULL,updated_at=now() WHERE path=$1 AND previous_audio_data IS NOT NULL RETURNING path,audio_version",[path]);
 if(!r.rowCount){problem(res,404,"No previous audio to roll back to");return;}
 res.json({ok:true,rolledBack:true,audioVersion:r.rows[0].audio_version});
}));
// Delete the Yiddish phrase and its audio for this button (English TTS stays).
router.delete("/admin/yemot/voice-studio/:path/phrase",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 if(req.body?.confirm!=="DELETE_YIDDISH_PHRASE"){problem(res,400,"Confirm Yiddish phrase deletion");return;}
 await pool.query("UPDATE "+dbTable+" SET yiddish_text='',audio_data=NULL,mime_type=NULL,published_path=NULL,published_at=NULL,voice='pinchas',language='en',audio_version=1,previous_audio_data=NULL,previous_mime_type=NULL,previous_audio_version=NULL,previous_voice=NULL,pending_regeneration=false,pending_voice=NULL,updated_at=now() WHERE path=$1",[path]);
 res.json({ok:true,deleted:true,language:"en"});
}));
router.post("/admin/yemot/voice-studio/:path/audio",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown menu path");return;}
 const mime=String(req.body?.mime||"").toLowerCase();
 const encoded=req.body?.base64;
 if(typeof encoded!=="string"||encoded.length>5_700_000||!/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)){
  problem(res,400,"Audio must be valid base64 under four megabytes");return;
 }
 const bytes=Buffer.from(encoded,"base64");
 if(!checkAudio(bytes,mime)){problem(res,415,"Unsupported audio format or invalid audio signature");return;}
 // Replace draft only, as a new version; the previous draft is kept for
 // rollback. A previously published file remains audible until the owner
 // explicitly publishes a replacement with a new, unique filename.
 const currentVoice=String((await pool.query("SELECT voice FROM "+dbTable+" WHERE path=$1",[path])).rows[0]?.voice||"pinchas");
 const version=await storeNewDraftVersion(path,bytes,mime,currentVoice);
 const q=await pool.query("SELECT octet_length(audio_data) AS size FROM "+dbTable+" WHERE path=$1",[path]);
 res.json({ok:true,audioSize:q.rows[0].size,live:false,needsPublish:true,audioVersion:version});
}));
router.get("/admin/yemot/voice-studio/:path/audio",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown menu path");return;}
 const q=await pool.query("SELECT audio_data,mime_type FROM "+dbTable+" WHERE path=$1",[path]);
 const item=q.rows[0];
 if(!item?.audio_data){problem(res,404,"No audio draft");return;}
 res.setHeader("Content-Type",item.mime_type||"application/octet-stream");
 res.setHeader("Cache-Control","private, no-store");
 res.setHeader("X-Content-Type-Options","nosniff");
 res.end(item.audio_data);
}));
// Permanently delete only the stored draft in Neon. Published audio remains untouched.
router.delete("/admin/yemot/voice-studio/:path/audio",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 if(req.body?.confirm!=="DELETE_SAVED_DRAFT_AUDIO"){problem(res,400,"Confirm draft audio deletion");return;}
 const q=await pool.query("UPDATE "+dbTable+" SET audio_data=NULL,mime_type=NULL,updated_at=now() WHERE path=$1 AND audio_data IS NOT NULL RETURNING path",[path]);
 res.json({ok:true,draftDeleted:!!q.rowCount,publishedAudioUnchanged:true});
}));
const providerRequest=async(token:string,operation:string,values:Record<string,string>)=>{
 const body=new URLSearchParams({token,...values});
 const response=await fetch("https://www.call2all.co.il/ym/api/"+operation,{
  method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
  body,redirect: "manual",cache:"no-store",signal:AbortSignal.timeout(20000)
 });
 if(!response.ok)throw Error("Yemot API unavailable");
 const result=await response.json() as {responseStatus?:string;files?:unknown[];dirs?:unknown[];fileExists?:boolean};
 if(result?.responseStatus!=="OK")throw Error("Yemot declined "+operation);
 return result;
};
const decrypt=(row:{token_nonce:string;token_ciphertext:string;token_tag:string})=>{
 const configured=process.env.YEMOT_ENCRYPTION_KEY||"";
 const key=Buffer.from(configured,"base64");
 if(key.length!==32||key.toString("base64")!==configured)throw Error("Yemot encryption key unavailable");
 const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(row.token_nonce,"base64"));
 decipher.setAAD(Buffer.from("gavhah:yemot:platform:v1"));
 decipher.setAuthTag(Buffer.from(row.token_tag,"base64"));
 return Buffer.concat([decipher.update(Buffer.from(row.token_ciphertext,"base64")),decipher.final()]).toString("utf8");
};

// Separate, explicitly-approved add-only media folder. Never edit the hotline
// root settings, existing folders, recordings, or customer-specific extensions.
router.post("/admin/yemot/voice-studio/prepare-folder",requireAuth,admin,wrap(async(req,res)=>{
 if(req.body?.confirm!=="CREATE_EMPTY_AUDIO_FOLDER_ONLY"){
  problem(res,400,"Confirm add-only audio-folder creation");return;
 }
 const current=await pool.query("SELECT media_folder FROM public.gavhah_yemot_voice_storage WHERE id=1");
 if(current.rows[0]){res.json({ok:true,alreadyReady:true,mediaFolder:current.rows[0].media_folder});return;}
 const [installed,global]=await Promise.all([
  pool.query("SELECT state FROM public.gavhah_yemot_ivr_install WHERE id=1"),
  pool.query("SELECT token_nonce,token_ciphertext,token_tag,enabled,last_verified_at FROM public.gavhah_yemot_global WHERE id=1")
 ]);
 if(installed.rows[0]?.state!=="live"||!global.rows[0]?.enabled||!global.rows[0]?.last_verified_at){
  problem(res,409,"Verified Yemot connection and existing root must be active");return;
 }
 const token=decrypt(global.rows[0]);
 const root=await providerRequest(token,"GetIVR2Dir",{path:"/"});
 if(!Array.isArray(root.dirs)||!Array.isArray(root.files)){
  problem(res,502,"Complete provider root directory inventory unavailable; no changes made");return;
 }
 const names=new Set<string>();
 for(const item of root.dirs){
  const candidate=typeof item==="string"?item:
   typeof item==="object"&&item!==null?String((item as {name?:string;path?:string;dir?:string}).name||
    (item as {path?:string}).path||(item as {dir?:string}).dir||""):"";
  if(!candidate){problem(res,409,"Ambiguous provider folder name; no changes made");return;}
  const suffix=candidate.replace(/\/+$/,"").split("/").pop()||"";
  if(/^[0-9]{1,3}$/.test(suffix))names.add(suffix);
 }
 const reserved=["897","896","895","894","893","892","891","890","887","886","885","884","883"];
 const candidate=reserved.find(x=>!names.has(x));
 if(!candidate){problem(res,409,"No free isolated media folder in the reserved pool");return;}
 const exists=await providerRequest(token,"CheckIfFileExists",{path:"ivr2:/"+candidate+"/ext.ini"});
 if(exists.fileExists!==false){problem(res,409,"Candidate may already contain files; aborting");return;}
 // Only a new child extension is added. 'hangup' prevents users who guess its
 // number from entering an unintended recording or management menu.
 await providerRequest(token,"UpdateExtension",{
  path:"ivr2:"+candidate,type:"hangup",title:"Gavhah audio assets - storage only"
 });
 const verified=await providerRequest(token,"GetIVR2Dir",{path:"/"+candidate});
 if(!Array.isArray(verified.files)||verified.files.length>0){
  problem(res,502,"Could not confirm isolated empty provider media folder");return;
 }
 await pool.query("INSERT INTO public.gavhah_yemot_voice_storage(id,media_folder) VALUES(1,$1) ON CONFLICT(id) DO NOTHING",
  ["/"+candidate]);
 res.json({ok:true,mediaFolder:"/"+candidate,verified:true,rootUnchanged:true});
}));

router.post("/admin/yemot/voice-studio/:path/publish",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(path==="1856"){problem(res,409,"The member ID changes for each registrant; edit this stage with dynamic {member_id} TTS instead of a static recording.");return;}
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown menu path");return;}
 if(req.body?.confirm!=="PUBLISH_TO_APPROVED_YEMOT_FOLDER"){
  problem(res,400,"Explicit publishing confirmation is required");return;
 }
 const row=await pool.query("SELECT audio_data,mime_type FROM "+dbTable+" WHERE path=$1",[path]);
 const asset=row.rows[0];
 if(!asset?.audio_data){problem(res,404,"Record or upload audio first");return;}
 const [installed,global]=await Promise.all([
  pool.query("SELECT state FROM public.gavhah_yemot_ivr_install WHERE id=1"),
  pool.query("SELECT token_nonce,token_ciphertext,token_tag,enabled,last_verified_at FROM public.gavhah_yemot_global WHERE id=1")
 ]);
 const savedFolder=await pool.query("SELECT media_folder FROM public.gavhah_yemot_voice_storage WHERE id=1");
 const target=installed.rows[0];
 const mediaFolder=String(savedFolder.rows[0]?.media_folder||"");
 if(target?.state!=="live"||!/^\/[0-9]{2,3}$/.test(mediaFolder)){
  problem(res,409,"A verified add-only Yemot extension must be live first; root untouched");return;
 }
 const conn=global.rows[0];
 if(!conn?.enabled||!conn?.last_verified_at){problem(res,409,"Central Yemot connection is not active");return;}
 const token=decrypt(conn);
 const directory="ivr2:"+mediaFolder;
 const before=await providerRequest(token,"GetIVR2Dir",{path:directory});
 if(!Array.isArray(before.files))throw Error("Cannot verify approved Yemot media folder");
 const file="gavhah_"+randomUUID().replace(/-/g,"")+".wav";
 const basename=file.slice(0,-4);
 const fileName=(x:unknown)=>typeof x==="string"?x:typeof x==="object"&&x!==null?String((x as {name?:string;fileName?:string;path?:string}).name||(x as {fileName?:string}).fileName||(x as {path?:string}).path||""):"";
 // Provider may return file objects in several name formats. Do not reuse a filename.
 if( before.files.some(x=>fileName(x).endsWith("/"+file)||fileName(x)===file))
  throw Error("Yemot media name collision");
 const form=new FormData();
 form.set("token",token);form.set("path",directory+"/"+file);
 form.set("convertAudio","1");form.set("autoNumbering","false");form.set("tts","0");
 form.set("qqfile",new Blob([new Uint8Array(asset.audio_data)],{type:asset.mime_type}),file);
 const up=await fetch("https://www.call2all.co.il/ym/api/UploadFile",{
  method:"POST",body:form,redirect: "manual",cache:"no-store",signal:AbortSignal.timeout(45000)
 });
 if(!up.ok)throw Error("Yemot media upload failed");
 const result=await up.json() as {responseStatus?:string};
 if(result.responseStatus!=="OK")throw Error("Yemot did not accept media");
 const after=await providerRequest(token,"GetIVR2Dir",{path:directory});
 if(!Array.isArray(after.files)||!after.files.some(x=>
  fileName(x).includes(basename))){
  problem(res,502,"Yemot did not confirm the uploaded file; old recording left unchanged");return;
 }
 const published=directory+"/"+file;
 await pool.query("UPDATE "+dbTable+" SET published_path=$2,published_at=now(),updated_at=now() WHERE path=$1",[path,published]);
 res.json({ok:true,verified:true,publishedPath:published,liveOnConnectedExtension:true});
}));

router.delete("/admin/yemot/voice-studio/:path/published",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown telephone menu path");return;}
 if(req.body?.confirm!=="USE_TTS_INSTEAD_OF_AUDIO"){
  problem(res,400,"Explicit audio deactivation confirmation required");return;
 }
 // Do not delete provider audio; only change the active prompt pointer.
 await pool.query("UPDATE "+dbTable+" SET published_path=NULL,published_at=NULL,updated_at=now() WHERE path=$1",[path]);
 res.json({ok:true,ttsFallback:true,providerFilesPreserved:true});
}));


// Physically delete a recorded WAV only if it is one of our own generated
// recordings inside our separately approved Yemot media-only folder.
router.post("/admin/yemot/voice-studio/:path/delete-published",requireAuth,admin,wrap(async(req,res)=>{
 const path=getName(req);
 if(!safePath(path)||!knownPath(path)){problem(res,400,"Unknown menu path");return;}
 if(req.body?.confirm!=="DELETE_PUBLISHED_GAVHAH_AUDIO"){problem(res,400,"Confirm deletion of published recording");return;}
 const [q,folder,global]=await Promise.all([
  pool.query("SELECT published_path FROM "+dbTable+" WHERE path=$1",[path]),
  pool.query("SELECT media_folder FROM public.gavhah_yemot_voice_storage WHERE id=1"),
  pool.query("SELECT token_nonce,token_ciphertext,token_tag,enabled,last_verified_at FROM public.gavhah_yemot_global WHERE id=1")
 ]);
 const published=String(q.rows[0]?.published_path||"");
 const dir=String(folder.rows[0]?.media_folder||"");
 if(!/^\/[0-9]{2,3}$/.test(dir) || !/^ivr2:\/[0-9]{2,3}\/gavhah_[a-f0-9]{32}\.wav$/.test(published) || !published.startsWith("ivr2:"+dir+"/")){
  problem(res,409,"Only explicitly published Gavhah-generated media in the approved folder can be deleted");return;
 }
 if(!global.rows[0]?.enabled||!global.rows[0]?.last_verified_at){problem(res,409,"Yemot central connection unavailable");return;}
 // Re-check recorded path and disconnect it from any callers before deleting the file.
 const saved=await pool.query("UPDATE "+dbTable+" SET published_path=NULL,published_at=NULL,updated_at=now() WHERE path=$1 AND published_path=$2 RETURNING path",[path,published]);
 if(!saved.rowCount){problem(res,409,"Published recording changed; nothing deleted");return;}
 try{
  const token=decrypt(global.rows[0]);
  const result=await providerRequest(token,"FileAction",{action:"delete",what:published});
  const remaining=await providerRequest(token,"GetIVR2Dir",{path:"ivr2:"+dir});
  const files=Array.isArray(remaining.files)?remaining.files:null;
  const found=files?.some(x=>String(typeof x==="string"?x:(x as {name?:string;path?:string;fileName?:string}).name||(x as {path?:string}).path||(x as {fileName?:string}).fileName||"").includes(published.split("/").pop()||""));
  if(!files||found)throw Error("The provider did not independently verify the file is gone");
  res.json({ok:true,deletedFromYemot:true,noLongerActive:true});
 }catch(e){
  // Never advertise deletion on an unverifiable provider operation.
  res.status(502).json({ok:false,noLongerActive:true,deletedFromYemotUnconfirmed:true,
   error:"The active recording was disabled, but deleting the provider file could not be verified. The extension and other recordings were not touched."});
 }
}));
export async function phonePromptOverride(path:string):Promise<{ttsText:string|null;audioPath:string|null;ttsMuted:boolean;yiddishText:string|null}>{
 const key=path||"root";
 if(!safePath(key))return {ttsText:null,audioPath:null,ttsMuted:false,yiddishText:null};
 try{
  const q=await pool.query("SELECT tts_text,tts_muted,published_path,language,yiddish_text FROM "+dbTable+" WHERE path=$1",[key]);
  const row=q.rows[0];
  const audioPath=String(row?.published_path||"");
  // A button switched to English plays no Yiddish recording (TTS fallback).
  const yiddish=row?.language!=="en";
  // Yiddish TEXT is NEVER spoken as TTS (English-default rule, Yakob
  // 2026-11-19 23:41): it is the recording's text only. The caller in
  // yemot-api-driven-phone uses ttsText (English) or audioPath (published
  // pinchas recording) and never yiddishText. The field is still
  // returned so the studio UI can show the recording's text.
  return {ttsText:typeof row?.tts_text==="string"&&row.tts_text.trim()?row.tts_text:null,ttsMuted:row?.tts_muted===true,
   audioPath:yiddish&&/^ivr2:\/[0-9]{1,3}\/gavhah_[a-f0-9]{32}\.wav$/.test(audioPath)?audioPath:null,
   yiddishText:yiddish&&typeof row?.yiddish_text==="string"&&row.yiddish_text.trim()?row.yiddish_text.trim():null};
 }catch(e){
  if((e as {code?:string})?.code==="42P01")return {ttsText:null,audioPath:null,ttsMuted:false,yiddishText:null};
  throw e;
 }
}
export default router;
