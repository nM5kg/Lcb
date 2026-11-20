import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";
import {phonePromptOverride} from "../routes/yemot-voice-studio";
import {applyFixedPhonePhraseEdits} from "../routes/gavhah-hotline-speech-library";
import { logger } from "./logger";
import {noteYemotReturnCalls} from "./signalwire-max-return-calls";
import type { Request, Response } from "express";
import { phoneNewsVote, saveVoiceNewsReply, savePhoneNewsSubmission, saveDiscussionVoiceOpening, phoneNewsSave, phoneNewsReport, validRecordedPath } from "./yemot-news-engagement";
import {enrollFromKeypad,pendingPhoneSignup,cancelPhoneSignup} from "./yemot-phone-signup";
import {sectionPaths,sectionRequiresLogin,pagedSections,readPhoneSection,currentPhoneActionId,confirmPhoneAction,publicIdSections,readPhonePublicById} from "./yemot-section-batch1";
import type { PoolClient } from "pg";
import { getTishlQueue, markTishlDone, deleteTishlItem, setTishlReminder, addTishlNote, toggleTishlHold } from "./tishl-queue";
import type { TishlQueueItem } from "./tishl-queue";
import { getCallLog, getMissedCalls, getCallingContacts, getOpenCasesAndProjects, resolveCaseSelection, resolveSingleOpenCase, insertCallReport, updateCallReport, upsertCallReport, updateSessionFill, insertScheduledCall, deleteLogEntry, deleteAllLogEntries, deleteContact, addContactNote, setContactDNC, insertPreparedSession, insertManualSession, sessionFillFromReport, ensureContactByPhone, getCategoryValues, getCategoryContacts, normalizeReportOutcome, purposeToReportColumns } from "./calling-queue";
import type { CaseProjectRow, CallPurpose, CategoryDimension, CategoryValue, CategoryContact } from "./calling-queue";
import { CALLING_TZ, parseCallingFlash, newCallingState, handleCallingDigit, callingMenuSpeech, filterMenuSpeech, describeCallingItem, detailMenuSpeech, contactMenuSpeech, editFieldSpeech, editValueSpeech, selectCaseSpeech, phoneEntrySpeech, fillOutcomeSpeech, fillAmountSpeech, fillMethodSpeech, fillPaidSpeech, fillPaidAmountSpeech, pickupAddressSpeech, fillNoteSpeech, fillMoodSpeech, dateChoiceSpeech, dateYearSpeech, callingHebrewMonthChoicesSpeech, attachCallingNote, advanceAfterPickupAddress, clampCallingPosAfterRemoval } from "./calling-phone";
import type { CallingState, CallingItemView, CallingEffect } from "./calling-phone";
import { newCategoriesState, parseCategoriesFlash, encodeCategoriesFlash, handleCategoriesDigit, categoriesMenuSpeech, describeCategoryValue, describeCategoryContact, amountEntrySpeech } from "./calling-categories";
import type { CategoriesState } from "./calling-categories";
import { placeOlamMaxOutboundCall } from "./signalwire-max-outbound";
import { hebrewFromGregorian, formatHebrewDate, parshaForGregorianDate, isHebrewLeapYear } from "./hebrew-calendar";
import { TISHL_TZ, parseTishlFlash, encodeTishlFlash, newTishlState, handleTishlDigit, splitSpeechChunks, describeTishlItem, actionMenuSpeech, hebrewMonthChoicesSpeech, buildVoiceNoteText, tzParts } from "./tishl-phone";
import type { TishlState } from "./tishl-phone";
import { verifyPassword } from "./crypto";
import { safeVoice, TRUE_ROOT_YIDDISH, TRUE_ROOT_ENGLISH, gateText, resolveRootTtsPrompt, gateAudioKeyForState, rootTargetForDigit, FAST_PATH_DIGITS, GATE_PATH, GATE_TARGET_4444, encodeGateFlash, parseGateFlash, DEPT_FIRST_SCREEN, GATE_FIRST_YI, GATE_FIRST_EN, GATE_REPROMPT_YI, GATE_REPROMPT_EN, GATE_WRONG_YI, GATE_WRONG_EN, GATE_NEED_ID_YI, GATE_NEED_ID_EN, GATE_WRONG_ID_YI, GATE_WRONG_ID_EN, GATE_PASSWORD_YI, GATE_PASSWORD_EN, GATE_LOCKED_YI, GATE_LOCKED_EN, GATE_WELCOME_YI, GATE_WELCOME_EN } from "./true-menu";
import type { GateFlash } from "./true-menu";

// ONE provider API bridge. All IVR paths, identities, and records are owned by
// Gavhah and Neon. No separate provider-side submenus, caller-ID login or
// recordings of card details.
type TreeNode={label:string;children?:Record<string,TreeNode>;details?:string};
type State={
 step:number;path:string;news_position:number;news_chunk:number;
 member_id:number|null;linked_until:string|null;login_failures:number;
 phone_page:number;selected_item_id:number|null;
 news_actions_open:boolean;news_reply_mode:boolean;news_reply_target:number|null;news_report_mode:boolean;
 action_flash:string;
};
const categories:Record<string,string>={
 "1121":"emergency_appeal","1122":"fundraising","1123":"announcement",
 "1124":"volunteer_call","1125":"alert","1126":"org_update","1127":"bikur_cholim",
 "1128":"community"
};
const newsAll="111",newsImportant="113";
const personalPaths=new Set(["121","122","123","124"]);
// TRUE MENU roots live in ./true-menu (TRUE_ROOT_YIDDISH /
// TRUE_ROOT_ENGLISH). The old hardcoded roots are gone:
//  - "Welcome to Gavhah and Campaign Center..." (2-option root) and
//  - the 9-option gavhahRoot ("Press 1 for News, 2 for My Askanus...").
// Both were English and wrong per live v117. The served root is the true
// 16-department menu, regardless of campaign4444 state, on Yemot
// and on SignalWire (one engine). English-default rule (Yakob 2026-11-19
// 23:41): the root speaks English TTS unless its pinchas recording is
// published; Yiddish text is the recording's text, never a TTS prompt.
// safeVoice() also lives in ./true-menu: its allowHebrew flag is never
// enabled by this engine — no Hebrew-script text reaches a TTS voice.
function gvPhoneSpokenWording(text:string):string{
 return text.replace(/\b(?:website|web[- ]?site)\s+(?:hotline\s+)?(?:configuration|config|settings)\b/gi,"Gavhah hotline")
  .replace(/\bon\s+the\s+(?:website|web[- ]?site)\b/gi,"in your Gavhah account")
  .replace(/\bweb[\s-]?(?:sites?|pages?)\b/gi,"Gavhah account")
  .replace(/\b(?:Cloudflare|SignalWire|Yemot|Render|API|callback|configuration)\b/gi,"the hotline")
  .replace(/\bpress\s+(?:zero|0)\s+to\s+(?:go\s+back|return)\b/gi,"press star to go back")
  .replace(/\s{2,}/g," ").trim();
}
function voice(s:string,allowHebrew=false,max=430){return "t-"+safeVoice(gvPhoneSpokenWording(s),max,allowHebrew);}
// A published recording's ivr2: path. Only a canonical gavhah_ file in
// a numbered Yemot folder may be played — anything else is text.
const isRecordingPath=(p:string|null|undefined):p is string=>
 !!p&&/^ivr2:\/[0-9]{1,3}\/gavhah_[a-f0-9]{32}\.wav$/.test(p);
function sendRead(res:Response,prompt:string,step:number,mode:"menu"|"root"|"news"|"code"|"article"|"record"|"registration"="menu",audioPath:string|null=null,allowHebrew=false,maxChars=430,audioPrefix:string|null=null){
 if(mode==="record"){
  res.type("text/plain; charset=utf-8").set("Cache-Control","no-store")
   .send("read="+voice(prompt)+"=rr"+step+",,record");return;
 }
 const name=(mode==="code"?"ln":mode==="article"?"ar":mode==="registration"?"rg":"iv")+step;
 // Yehmot's documented read order is:
 // name, reuse, maxDigits, minDigits, timeout, playback, blockStar,
 // blockZero, replacement, allowedDigits, retries, emptyIsOk, emptyValue.
 // Never shift positions or block digit zero. Most menus use the smallest
 // valid six/seven fields so a telephone speech issue can be isolated.
 // Read timeout (Yakob 2026-11-20 04:17 — "1 סעקונדע פאר יעדע קנעפל"):
 // ONE second of inter-digit wait on every button. The timeout resets
 // after EACH digit, so a longer entry gets another second per digit
 // (3 digits = 1s per gap, and so on). Multi-digit shortcuts work
 // again: 11/12/77/88/4444 (maxDigits=4 on menu/root). A single press
 // takes 1s wait + the server's ~1.5s = ~2.5s; "11" pressed quickly
 // takes ~1s + ~1.5s. Long numeric entry keeps its digit counts
 // (code 8, registration 16, article 8) with the same 1s per digit.
 const opts=mode==="code"
 ? [name,"no","8","8","1","No","no"]
 : mode==="registration"
 ? [name,"no","16","1","1","No","no"]
 : mode==="article"
 ? [name,"no","8","1","1","No","no"]
 : mode==="news"
 // News/Discussions list: star and pound are allowed here (quick insert
 // and back) — Yakob 2026-11-20 04:46. Whether Yemot actually delivers
 // "*" and "#" in a menu read is UNVERIFIED and needs a physical test;
 // the list also offers 9 as a back fallback and 0 for the insert menu.
 ? [name,"no","1","0","1","No","no","no","","0123456789*#","1","Ok","None"]
 : mode==="root"
 ? [name,"no","4","1","1","No","no"]
 : [name,"no","4","1","1","No","no"];
 const audio=audioPath&&/^ivr2:\/[0-9]{1,3}\/gavhah_[a-f0-9]{32}\.wav$/.test(audioPath)
  ? "f-"+audioPath.slice(5).replace(/\.wav$/,"") : null;
 const backHint=step>0&&mode!=="root"&&!/press zero to (go back|return)/i.test(prompt)?" To go back one menu, press zero.":"";
 // A recording replaces the text prompt, so the navigation keys would be
 // lost. audioPrefix (headline + keys) is spoken as text BEFORE the file:
 // t-<prefix>.f-<file>. Without a prefix the old back hint is kept.
 const providerBody="read="+(audio?(audioPrefix?voice(audioPrefix,allowHebrew,maxChars)+"."+audio:(step>0&&mode!=="root"?voice("To go back one menu press zero")+"."+audio:audio)):voice(prompt+backHint,allowHebrew,maxChars))+"="+opts.join(",");
 if(step===0)logger.info({ivrResponse:"read",mode,step,promptCharacters:prompt.length,patternVersion:"basic-read-v2"},"Yemot welcome reply delivered");
 res.type("text/plain; charset=utf-8").set("Cache-Control","no-store").send(providerBody);
}
// English-default rule (Yakob 2026-11-19 23:41): the root prompt is
// English unless a caller explicitly asks for the Yiddish recording text
// (englishRoot=false, kept only for tests — the engine never passes
// false). Yiddish reaches the caller ONLY as a published pinchas
// recording; the Yiddish root text is that recording's text, never a
// TTS prompt.
export function menuPrompt(path:string,tree:Record<string,TreeNode>,englishRoot=true){
 const rootText=englishRoot?TRUE_ROOT_ENGLISH:TRUE_ROOT_YIDDISH;
 let nodes=tree,current:TreeNode|undefined;
 for(const d of path){current=nodes[d];if(!current)return rootText;nodes=current.children||{};}
 if(!path)return rootText;
 if(!current?.children)return current?.details||"This option is not ready on the phone. Press zero to return to the main menu.";
 return current.label+". "+Object.entries(nodes)
  .map(([n,item])=>"Press "+n+" for "+item.label+".").join(" ")+
  " To go back one menu, press zero.";
}
// Only parent-navigation menus can be replaced with a recorded custom
// greeting. Dynamic public and private content must NEVER be shadowed.
function isNavigationalMenu(path:string,tree:Record<string,TreeNode>){
 if(!path)return true;
 let nodes=tree;
 let current:TreeNode|undefined;
 for(const digit of path){
  current=nodes[digit];
  if(!current)return false;
  nodes=current.children||{};
 }
 return !!current?.children;
}
function treeSelect(path:string,digit:string,tree:Record<string,TreeNode>){
 if(digit==="0")return "";
 if(!/^[1-9]$/.test(digit))return path;
 let nodes=tree;
 for(const d of path){if(!nodes[d]?.children)return path;nodes=nodes[d].children||{};}
 return nodes[digit]?path+digit:path;
}
function newsPath(path:string){
 return path===newsAll||path===newsImportant||path==="114"||path in categories||path==="1129";
}
async function getNews(path:string,pos:number){
 let filter="";
 let params:unknown[]=[pos];
 if(path===newsImportant)filter="urgency IN ('high','breaking')";
 else if(path==="114")filter="is_featured=true";
 else if(path==="1129")filter="category IN ('medical','wedding')";
 else if(categories[path]){filter="category=$2";params=[pos,categories[path]];}
 // Website -> hotline gate (Yakob 2026-11-20 04:54 rule 1): a website
 // update reaches the hotline ONLY if a recording was filled in the
 // separate recording box — a published row in gavhah_post_audio.
 // Text-only updates stay on the website. The gate applies to every
 // news list (all, important, featured, categories, medical/wedding).
 const gate="EXISTS (SELECT 1 FROM public.gavhah_post_audio pa WHERE pa.post_type='news' AND pa.post_id=public.news.id AND pa.review_status='published')";
 const query="SELECT id,title,content,summary,urgency,"+
  // Build B (Yakob 2026-11-20): the published recording's Yemot path, so
  // the line plays the actual recording on Yemot instead of the text.
  // NULL when the recording was published before this build (article 17)
  // — then the text is the fallback until an admin re-approves it.
  "(SELECT yemot_path FROM public.gavhah_post_audio pa WHERE pa.post_type='news' AND pa.post_id=public.news.id AND pa.review_status='published' LIMIT 1) AS yemot_path "+
  "FROM public.news "+
  "WHERE "+gate+(filter?" AND "+filter:"")+" ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET $1";
 const r=await pool.query<{id:number;title:string;content:string|null;summary:string|null;urgency:string;yemot_path:string|null}>(query,params);
 return r.rows[0]||null;
}
// The recording gate for a single article id (used by the by-number
// entry): true only when a published recording is attached.
async function newsHasPublishedAudio(client:import("pg").PoolClient,id:number){
 const r=await client.query(
  "SELECT 1 FROM public.gavhah_post_audio WHERE post_type='news' AND post_id=$1 AND review_status='published' LIMIT 1",[id]);
 return (r.rowCount||0)===1;
}
async function discussionHasPublishedAudio(client:import("pg").PoolClient,id:number){
 const r=await client.query(
  "SELECT 1 FROM public.gavhah_post_audio WHERE post_type='discussion' AND post_id=$1 AND review_status='published' LIMIT 1",[id]);
 return (r.rowCount||0)===1;
}
// The return list path stored in action_flash when the caller enters an
// insert menu (116 for News, 97020 for Discussions): {"newsFrom":"111"}
// or {"discFrom":"97021"}. The gate flash uses the same field with a
// different key, so the reader takes the key it wants.
function readReturnPath(value:string|null|undefined,key:"newsFrom"|"discFrom"):string|null{
 try{
  const p=JSON.parse(value||"") as Record<string,unknown>;
  const v=p?.[key];
  return typeof v==="string"&&v?v:null;
 }catch{return null;}
}
async function newsPrompt(path:string,position:number,chunkIndex:number){
 const post=await getNews(path,position);
 if(!post)return{
  // The list holds only updates WITH a published recording (rule 1), so
  // an empty category means no recorded updates there — the text-only
  // updates are on the website.
  text:(position?"You have reached the end of these updates. ":"No updates with a recording in this category. Text updates are on the website. ")+
    "Press 2 to restart. Press 3 for important and critical news. Press 4 for all updates. Press star to insert an update, or zero for the insert menu.",
  hasMore:false,
  audio:null as string|null,
  audioPrefix:null as string|null
 };
 const body=safeVoice(post.content||post.summary,30000);
 const chunks:string[]=[];
 let remaining=body;
 while(remaining.length){
  if(remaining.length<=215){chunks.push(remaining);break;}
  let split=remaining.lastIndexOf(" ",215);
  if(split<130)split=215;
  chunks.push(remaining.slice(0,split));
  remaining=remaining.slice(split).trimStart();
 }
 if(!chunks.length)chunks.push("This update needs an English or verified Yiddish audio version. The original remains available on the website.");
 const part=Math.max(0,Math.min(chunkIndex,chunks.length-1));
 // Numbering (Yakob 2026-11-20 04:46): the STABLE article id, not the
 // position in the newest-first list — the id is the number the caller
 // uses to select the update by number.
 const headline=part===0?"News update "+post.id+". "+
  (safeVoice(post.title,65)||"This title is in Yiddish")+". ":"";
 // Keys (Yakob 2026-11-20 04:46): 1 = by number, 2 = next, 3 =
 // important and critical, 4 = all, 5 = this update options, 8 =
 // previous, star = insert, pound = back, 0 = insert menu. Kept short
 // on purpose: headline (<=~80) + chunk (<=215) + this line must fit
 // the 430-char read cap.
 const keys=". Press 1 by number, 2 next, 3 important and critical, 4 all, 5 options, 8 previous, star insert, pound back, zero insert menu.";
 // Build B: the recording plays on Yemot (chunk 0 only — the whole
 // recording is one hearing); SignalWire keeps the text. The headline +
 // keys are spoken as text before the file, so the caller still hears
 // which update this is and which keys work.
 const audio=part===0&&isRecordingPath(post.yemot_path)?post.yemot_path:null;
 return{
  text:headline+chunks[part]+keys,
  hasMore:part<chunks.length-1,
  audio,
  audioPrefix:audio?headline+keys:null
 };
}
async function articlePrompt(client:import("pg").PoolClient,id:number,part:number){
 // The by-number entry is gated too (rule 1): only an update with a
 // published recording can be heard. A text-only update is named as such
 // (it is on the website), a missing id as not found.
 const r=await client.query<{title:string;content:string|null;summary:string|null;yemot_path:string|null}>(
  "SELECT title,content,summary,"+
  "(SELECT yemot_path FROM public.gavhah_post_audio pa WHERE pa.post_type='news' AND pa.post_id=public.news.id AND pa.review_status='published' LIMIT 1) AS yemot_path "+
  "FROM public.news WHERE id=$1 AND EXISTS "+
  "(SELECT 1 FROM public.gavhah_post_audio pa WHERE pa.post_type='news' AND pa.post_id=public.news.id AND pa.review_status='published')",[id]);
 if(!r.rows[0]){
  const exists=await client.query("SELECT 1 FROM public.news WHERE id=$1",[id]);
  return {text:exists.rowCount
   ?"This update has no recording on the phone. Text updates are on the website. Press 2 to enter another article number or zero for the main menu."
   :"This news update was not found. Press 2 to enter another article number or zero for the main menu.",hasMore:false,audio:null as string|null,audioPrefix:null as string|null};
 }
 const data=r.rows[0];
 const body=safeVoice(data.content||data.summary,30000);
 const parts:string[]=[];
 let remain=body;
 while(remain.length){
  if(remain.length<=230){parts.push(remain);break;}
  let split=remain.lastIndexOf(" ",230);
  if(split<140)split=230;
  parts.push(remain.slice(0,split));
  remain=remain.slice(split).trimStart();
 }
 if(!parts.length)parts.push("This update needs an English or approved Yiddish recording.");
 const current=Math.min(part,parts.length-1);
 const headline=current===0?"Article "+id+". "+(safeVoice(data.title,80)||"Yiddish headline")+". ":"";
 const keys=". Press 1 for article actions, 2 for next part, 8 to restart this article, or zero for the main menu.";
 // Build B: the recording plays on Yemot (part 0 only); SignalWire keeps
 // the text. Headline + keys are spoken before the file.
 const audio=current===0&&isRecordingPath(data.yemot_path)?data.yemot_path:null;
 return{
  text:headline+parts[current]+keys,
  hasMore:current<parts.length-1,
  audio,
  audioPrefix:audio?headline+keys:null
 };
}
async function currentNewsId(path:string,position:number,chosen:number|null):Promise<number|null>{
 if(path==="115")return chosen;
 const post=await getNews(path,position);
 return post?.id||null;
}
// Discussions (Askanim talk) on the phone — the same structure as News
// (Yakob 2026-11-20 04:46), with the same recording gate (rule 1) and
// the same stable-id numbering. No transcription for discussions
// (rule 4): recordings stay as recordings only.
async function getDiscussions(pos:number){
 const r=await pool.query<{id:number;title:string;content:string|null;is_locked:boolean;comment_count:number;yemot_path:string|null}>(
  "SELECT id,title,content,is_locked,comment_count,"+
  "(SELECT yemot_path FROM public.gavhah_post_audio pa WHERE pa.post_type='discussion' AND pa.post_id=public.discussions.id AND pa.review_status='published' LIMIT 1) AS yemot_path "+
  "FROM public.discussions "+
  "WHERE EXISTS (SELECT 1 FROM public.gavhah_post_audio pa WHERE pa.post_type='discussion' AND pa.post_id=public.discussions.id AND pa.review_status='published') "+
  "ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET $1",[pos]);
 return r.rows[0]||null;
}
async function currentDiscussionId(position:number):Promise<number|null>{
 const post=await getDiscussions(position);
 return post?.id||null;
}
async function discussionPrompt(position:number,chunkIndex:number){
 const post=await getDiscussions(position);
 if(!post)return{
  text:(position?"You have reached the end of these discussions. ":"No discussions with a recording on the phone yet. Text discussions are on the website. ")+
   "Press 2 to restart. Press star to insert a discussion, or zero for the insert menu.",
  hasMore:false,
  audio:null as string|null,
  audioPrefix:null as string|null
 };
 const body=safeVoice(post.content,30000);
 const chunks:string[]=[];
 let remaining=body;
 while(remaining.length){
  if(remaining.length<=215){chunks.push(remaining);break;}
  let split=remaining.lastIndexOf(" ",215);
  if(split<130)split=215;
  chunks.push(remaining.slice(0,split));
  remaining=remaining.slice(split).trimStart();
 }
 if(!chunks.length)chunks.push("This discussion needs an English or verified Yiddish audio version. The original remains available on the website.");
 const part=Math.max(0,Math.min(chunkIndex,chunks.length-1));
 const headline=part===0?"Discussion "+post.id+". "+
  (safeVoice(post.title,65)||"This title is in Yiddish")+". ":"";
 // Keys mirror the News list, but there is no actions menu for
 // discussions (a recording-reply option is a follow-up, gated on the
 // discussion being on the phone — which this list already guarantees).
 const keys=". Press 1 by number, 2 next, 8 previous, star to insert, pound to go back, zero for the insert menu.";
 // Build B: the recording plays on Yemot (chunk 0 only); SignalWire
 // keeps the text. Headline + keys are spoken before the file.
 const audio=part===0&&isRecordingPath(post.yemot_path)?post.yemot_path:null;
 return{
  text:headline+chunks[part]+keys,
  hasMore:part<chunks.length-1,
  audio,
  audioPrefix:audio?headline+keys:null
 };
}
async function discussionByIdPrompt(client:import("pg").PoolClient,id:number,part:number){
 const r=await client.query<{title:string;content:string|null;yemot_path:string|null}>(
  "SELECT title,content,"+
  "(SELECT yemot_path FROM public.gavhah_post_audio pa WHERE pa.post_type='discussion' AND pa.post_id=public.discussions.id AND pa.review_status='published' LIMIT 1) AS yemot_path "+
  "FROM public.discussions WHERE id=$1 AND EXISTS "+
  "(SELECT 1 FROM public.gavhah_post_audio pa WHERE pa.post_type='discussion' AND pa.post_id=public.discussions.id AND pa.review_status='published')",[id]);
 if(!r.rows[0]){
  const exists=await client.query("SELECT 1 FROM public.discussions WHERE id=$1",[id]);
  return {text:exists.rowCount
   ?"This discussion has no recording on the phone. Text discussions are on the website. Press 2 to enter another discussion number or zero for the main menu."
   :"This discussion was not found. Press 2 to enter another discussion number or zero for the main menu.",hasMore:false,audio:null as string|null,audioPrefix:null as string|null};
 }
 const data=r.rows[0];
 const body=safeVoice(data.content,30000);
 const parts:string[]=[];
 let remain=body;
 while(remain.length){
  if(remain.length<=230){parts.push(remain);break;}
  let split=remain.lastIndexOf(" ",230);
  if(split<140)split=230;
  parts.push(remain.slice(0,split));
  remain=remain.slice(split).trimStart();
 }
 if(!parts.length)parts.push("This discussion needs an English or approved Yiddish recording.");
 const current=Math.min(part,parts.length-1);
 const headline=current===0?"Discussion "+id+". "+(safeVoice(data.title,80)||"Yiddish title")+". ":"";
 const keys=". Press 2 for next part, 8 to restart, 9 for another discussion, or zero for the main menu.";
 // Build B: the recording plays on Yemot (part 0 only); SignalWire keeps
 // the text. Headline + keys are spoken before the file.
 const audio=current===0&&isRecordingPath(data.yemot_path)?data.yemot_path:null;
 return{
  text:headline+parts[current]+keys,
  hasMore:current<parts.length-1,
  audio,
  audioPrefix:audio?headline+keys:null
 };
}
async function actionsMenu(client:import("pg").PoolClient,articleId:number|null,userId:number|null,validMember:boolean){
 if(!articleId)return "This news update is no longer available. Press nine to resume or zero for the main menu.";
 const r=await client.query<{like_count:number}>("SELECT like_count FROM public.news WHERE id=$1",[articleId]);
 const counter=r.rows[0]?.like_count??0;
 return "Update "+articleId+" options. Press 1 to upvote. Press 2 to remove an upvote. "+
  "Press 3 to record an audio reply for moderation. Press 4 to hear current upvote count. "+
  "Press 5 to save this article. Press 6 to remove it from saved. Press 7 to report this article. "+
  "Press 9 to return to listening or zero for the main menu. "+
  "Current upvotes "+counter+". "+(validMember?"You are signed in.":"To vote or reply, first link your account with the website code under My Askanus.") ;
}
async function memberAllowed(client:import("pg").PoolClient,state:State){
 if(!state.member_id||!state.linked_until||new Date(state.linked_until).getTime()<Date.now())return false;
 const r=await client.query(
  "SELECT id FROM public.users WHERE id=$1 AND status NOT IN ('banned','suspended')",[state.member_id]);
 return r.rowCount===1;
}
async function myPrompt(client:import("pg").PoolClient,path:string,userId:number,page:number,confirmId:number|null){
 if(path==="124"){
  const r=await client.query(
   "SELECT (SELECT count(*) FROM public.askanus_tasks WHERE user_id=$1 AND completed=false)::int AS pending,"+
   "(SELECT count(*) FROM public.askanus_cases WHERE user_id=$1 AND status!='closed')::int AS open_cases,"+
   "(SELECT count(*) FROM public.askanus_notes WHERE user_id=$1)::int AS notes",[userId]);
  const x=r.rows[0];
  return "My Askanus dashboard. "+x.pending+" pending tasks, "+x.open_cases+" open cases and "+x.notes+
   " notes. This is the same account as the website. Press zero for the main menu.";
 }
 const spec=path==="121"?
  {table:"askanus_tasks",fields:"id,title,deadline,priority,completed",name:"tasks"}:
  path==="122"?
  {table:"askanus_cases",fields:"id,title,status,urgency,deadline,goal_amount",name:"cases"}:
  {table:"askanus_notes",fields:"id,title,content",name:"notes"};
 // Identifiers are fixed constants. No user-supplied SQL identifiers.
 const r=await client.query(
   "SELECT "+spec.fields+" FROM public."+spec.table+
   " WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET $2",[userId,page]);
 const x=r.rows[0];
 if(!x)return "You have reached the end of your "+spec.name+
  ". Press 2 to restart, 8 for previous, or zero for the main menu.";
 const heading=spec.name+" item "+(page+1)+". "+(safeVoice(x.title,125)||"This title needs an English audio version")+". ";
 if(path==="121")return heading+
  "Priority "+x.priority+". "+(x.completed?"Completed. ":"Not yet completed. ")+
  (x.deadline?"Due "+safeVoice(x.deadline,28)+". ":"")+
  (x.completed?"":"Press 5, then press 5 again, to mark this task complete. ")+
  (confirmId===x.id?"Confirm completion by pressing 5 now. ":"")+
  "Press 1 for next, 8 for previous, 2 for restart, or zero for the main menu.";
 if(path==="122")return heading+"Status "+x.status+". Priority "+x.urgency+". "+
  (x.deadline?"Deadline "+safeVoice(x.deadline,22)+". ":"")+
  "Recorded goal "+Number(x.goal_amount)+" dollars. "+
  "Press 1 for next, 8 for previous, 2 to restart, or zero for the main menu.";
 return heading+(safeVoice(x.content,170)||"This note needs an English audio version.")+
  ". Press 1 for next, 8 for previous, 2 to restart, or zero for the main menu.";
}
function sourceCallId(req:Request){
 const raw=String(req.body?.ApiCallId??req.query.ApiCallId??"");
 return /^[A-Za-z0-9_.:-]{8,160}$/.test(raw)?raw:null;
}
async function exactSecret(req:Request){
 const supplied=String(req.body?.entryKey??req.query.entryKey??"");
 if(!/^[a-f0-9]{64}$/.test(supplied))return null;
 if(req.path.endsWith("/shared-ivr")){
  // Only an already provider-signed webhook can receive this derived secret.
  // Keep it separate from the original Yemot and next-line callbacks.
  const key=String(process.env.SIGNALWIRE_SIGNING_KEY||"");
  if(key.length<24)return null;
  const row=(await pool.query("SELECT route_fingerprint,audit_state FROM public.gavhah_signalwire_shared_route "+
   "WHERE id=1 AND requested_number='6056558080' AND old_extension='55555' AND cutover_enabled=true")).rows[0];
  if(row?.audit_state!=="verified_compatibility_voice_url"||
     !/^[a-f0-9]{64}$/.test(String(row?.route_fingerprint||"")))return null;
  const expected=createHmac("sha256",key).update("gavhah-shared-55555-v1:"+row.route_fingerprint).digest("hex");
  return timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(supplied,"hex"))?supplied:null;
 }
 if(req.path.endsWith("/next-ivr")){
  const selected=await pool.query("SELECT callback_hash,stage,provider_kind FROM public.gavhah_hotline_migration WHERE id=1");
  const record=selected.rows[0];
  if(record?.stage!=="testing"||!["yemot","signalwire"].includes(String(record?.provider_kind))||
     !/^[a-f0-9]{64}$/.test(String(record.callback_hash||"")))return null;
  const suppliedHash=createHash("sha256").update(supplied).digest("hex");
  return timingSafeEqual(Buffer.from(record.callback_hash,"hex"),Buffer.from(suppliedHash,"hex"))?supplied:null;
 }
 if(req.path.endsWith("/4444")){
  const value=process.env.YEMOT_ENCRYPTION_KEY||"";
  const key=Buffer.from(value,"base64");
  if(key.length!==32||key.toString("base64")!==value)return null;
  const expected=createHmac("sha256",key).update("gavhah-campaign-4444-callback-v1").digest("hex");
  if(!timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(supplied,"hex")))return null;
  const installed=await pool.query("SELECT provider_summary #>> '{campaign4444,state}' AS state FROM public.gavhah_yemot_ivr_install WHERE id=1");
  return installed.rows[0]?.state==="live"?supplied:null;
 }
 const result=await pool.query<{callback_hash:string;state:string}>(
  "SELECT callback_hash,state FROM public.gavhah_yemot_ivr_install WHERE id=1");
 const expected=result.rows[0]?.callback_hash;
 if(typeof expected!=="string"||!["installing","live"].includes(result.rows[0]?.state))return null;
 const provided=createHash("sha256").update(supplied).digest("hex");
 return expected.length===provided.length&&
  timingSafeEqual(Buffer.from(expected),Buffer.from(provided))?supplied:null;
}
type ManualResultPending={
 stage:"choose"|"confirm";userId:number;contactId:number;caseId:number;
 contactName:string;outcome?:string;expiresAt:number;requestId:string;
};
const manualOutcomes:Record<string,string>={
 "1":"spoke","2":"no_answer","3":"callback","4":"not_interested","5":"do_not_call"
};
function readManualResultPending(value:string):ManualResultPending|null{
 try{
  const p=JSON.parse(value) as ManualResultPending;
  if(!p||!["choose","confirm"].includes(p.stage)||!Number.isSafeInteger(p.userId)||
   !Number.isSafeInteger(p.contactId)||p.contactId<=0||!Number.isSafeInteger(p.caseId)||
   p.caseId<=0||!Number.isFinite(p.expiresAt)||p.expiresAt<Date.now()||
   typeof p.contactName!=="string"||typeof p.requestId!=="string"||
   !/^[a-f0-9]{64}$/.test(p.requestId))return null;
  if(p.stage==="confirm"&&!Object.values(manualOutcomes).includes(p.outcome||""))return null;
  return p;
 }catch{return null;}
}
const choosePrompt="Manual result for the selected contact. Press 1 if you spoke, 2 if no answer, "+
 "3 for callback requested, 4 for not interested, or 5 for Do Not Call. "+
 "Press zero to cancel. This does NOT initiate an outbound phone call.";
const confirmationPrompt=(p:ManualResultPending)=>
 "You selected "+(p.outcome||"").replace(/_/g," ")+
 ". Press 5 again to SAVE the result to your Gavhah MAX website history. "+
 "Press zero to cancel. No money, donation, or payment will be recorded.";
async function recordConfirmedManualResult(client:import("pg").PoolClient,p:ManualResultPending){
 // Recheck ownership and DNC status at commit time, not only when the menu
 // first opened. A moved contact or closed case cannot receive a new result.
 const contact=await client.query<{id:number;name:string;do_not_call:boolean}>(
  "SELECT id,name,do_not_call FROM public.communication_contacts "+
  "WHERE id=$1 AND user_id=$2 FOR UPDATE",[p.contactId,p.userId]);
 const owned=contact.rows[0];
 const test=await client.query<{id:number}>(
  "SELECT id FROM public.askanus_cases WHERE id=$1 AND user_id=$2 AND status!='closed' FOR UPDATE",
  [p.caseId,p.userId]);
 if(!owned||!test.rows[0]||owned.do_not_call)return "Contact is unavailable or marked Do Not Call. Nothing was saved.";
 const outcome=p.outcome||"other";
 const ins=await client.query<{id:number}>(
  "INSERT INTO public.fundraising_call_reports "+
  "(user_id,case_id,contact_id,contact_name,outcome,money_kind,amount,note,request_id,observed_mood) "+
  "VALUES ($1,$2,$3,$4,$5,'none',0,$6,$7,'neutral') "+
  "ON CONFLICT(user_id,request_id) DO NOTHING RETURNING id",
  [p.userId,p.caseId,p.contactId,owned.name,outcome,"Manual call outcome saved from verified Yemot IVR",p.requestId]);
 if(!ins.rows[0])return "This result was already saved. No duplicate was created.";
 await client.query(
  "INSERT INTO public.case_activity_log(case_id,date,type,note) VALUES($1,$2,'contact',$3)",
  [p.caseId,new Date().toISOString().slice(0,10),
   ("Telephone IVR manual call report: "+owned.name+" - "+outcome).slice(0,1400)]);
 if(outcome==="do_not_call"){
  await client.query("UPDATE public.communication_contacts "+
   "SET do_not_call=true,opt_out_reason='Do Not Call explicitly confirmed through verified Yemot hotline',updated_at=now() "+
   "WHERE id=$1 AND user_id=$2",[p.contactId,p.userId]);
 }
 return "Saved to your MAX website call history. "+
  (outcome==="do_not_call"?"Do Not Call protection is now enabled. ":"")+
  "No actual call was placed and no payment was collected.";
}


/**
 * Fast authenticated single-digit root navigation (TRUE MENU version).
 * The campaign4444 fork is gone: the true 16-department Yiddish root is
 * served regardless of campaign state, and root digits map via ROOT_MAP
 * (true-menu.ts), not via the old "1"+digit prefixing.
 * Only 1/7/9 keep the shortcut (their slow-path render is exactly
 * menuPrompt()); every other digit falls through to the slow path, which
 * owns the special live first screens, the 159 Olam gate and the login
 * gate. A gated digit from a logged-out caller also falls through, so the
 * slow path can send the gate instead of the department.
 */
async function tryFastYemotRoot(req:Request,res:Response,tree:Record<string,TreeNode>):Promise<boolean>{
 if(!req.path.endsWith("/yemot/ivr"))return false;
 const digit=req.body?.iv0??req.query.iv0;
 const input=digit==null?null:String(digit);
 if(input!==null&&!/^[1-9]$/.test(input))return false;
 const call=sourceCallId(req);
 const supplied=String(req.body?.entryKey??req.query.entryKey??"");
 if(!call||!/^[a-f0-9]{64}$/.test(supplied))return false;
 const got=createHash("sha256").update(supplied).digest("hex");
 if(input===null){
  const rows=await pool.query(
   "SELECT i.callback_hash,i.state,g.enabled,g.last_verified_at,v.tts_text,v.published_path,v.yiddish_text,v.language "+
   "FROM public.gavhah_yemot_ivr_install i JOIN public.gavhah_yemot_global g ON g.id=1 "+
   "LEFT JOIN public.gavhah_yemot_voice_prompts v ON v.path='root' WHERE i.id=1");
  const cfg=rows.rows[0];
  if(!cfg||!cfg.enabled||!cfg.last_verified_at||!["installing","live"].includes(cfg.state)||
     !/^[a-f0-9]{64}$/.test(String(cfg.callback_hash||""))||
     !timingSafeEqual(Buffer.from(cfg.callback_hash,"hex"),Buffer.from(got,"hex"))){
   res.status(403).type("text/plain").send("Access denied");return true;
  }
  // SignalWire cannot play an ivr2: file, so on the shared-ivr route the
  // root speaks its English text; Yemot plays the published pinchas file.
  const audio=!req.path.endsWith("/shared-ivr")&&typeof cfg.published_path==="string"&&/^ivr2:\/[0-9]{1,3}\/gavhah_[a-f0-9]{32}\.wav$/.test(cfg.published_path)?cfg.published_path:null;
  // English-default rule (Yakob 2026-11-19 23:41): the root speaks the
  // row's English tts_text when it is plain-ASCII English, else the
  // hardcoded English root. The Yiddish root text is the RECORDING's
  // text — it is never passed to a TTS voice. When the root audio is
  // published, sendRead plays it instead of this prompt.
  const prompt=resolveRootTtsPrompt(cfg.tts_text);
  sendRead(res,prompt,0,"root",audio,false,950);return true;
 }
 if(!FAST_PATH_DIGITS.includes(input))return false;
 const target=rootTargetForDigit(input);
 if(!target||target.kind!=="path")return false;
 const callHash=createHmac("sha256",supplied).update(call).digest("hex");
 const rows=await pool.query(
  "WITH cfg AS ("+
   "SELECT i.callback_hash,i.state,g.enabled,g.last_verified_at "+
   "FROM public.gavhah_yemot_ivr_install i JOIN public.gavhah_yemot_global g ON g.id=1 WHERE i.id=1"+
  "), allowed AS ("+
   "SELECT $2 AS target_path FROM cfg LEFT JOIN public.gavhah_yemot_call_states cs ON cs.call_hash=$1 "+
   "WHERE enabled=true AND last_verified_at IS NOT NULL AND state IN ('installing','live') AND callback_hash=$3 "+
   "AND ($2='11' OR (cs.member_id IS NOT NULL AND cs.linked_until>now()))"+
  "), changed AS ("+
   "INSERT INTO public.gavhah_yemot_call_states(call_hash,step,path) "+
   "SELECT $1,1,target_path FROM allowed "+
   "ON CONFLICT(call_hash) DO UPDATE SET step=EXCLUDED.step,path=EXCLUDED.path,updated_at=now() "+
   "WHERE public.gavhah_yemot_call_states.step=0 AND public.gavhah_yemot_call_states.path='' "+
   "RETURNING step,path"+
  ") "+
  "SELECT cfg.callback_hash,cfg.state,cfg.enabled,cfg.last_verified_at,"+
  "changed.step,changed.path,v.tts_text,v.published_path FROM cfg LEFT JOIN changed ON TRUE "+
  "LEFT JOIN public.gavhah_yemot_voice_prompts v ON v.path=changed.path",
  [callHash,target.path,got]);
 const cfg=rows.rows[0];
 if(!cfg||!cfg.enabled||!cfg.last_verified_at||!["installing","live"].includes(cfg.state)||
    !/^[a-f0-9]{64}$/.test(String(cfg.callback_hash||""))||
    !timingSafeEqual(Buffer.from(cfg.callback_hash,"hex"),Buffer.from(got,"hex"))){
  res.status(403).type("text/plain").send("Access denied");return true;
 }
 if(!cfg.path)return false;
 const path=String(cfg.path);
 if(!isNavigationalMenu(path,tree))return false;
 const prompt=typeof cfg.tts_text==="string"&&cfg.tts_text.trim()?cfg.tts_text:menuPrompt(path,tree);
 const audio=!req.path.endsWith("/shared-ivr")&&typeof cfg.published_path==="string"&&/^ivr2:\/[0-9]{1,3}\/gavhah_[a-f0-9]{32}\.wav$/.test(cfg.published_path)?cfg.published_path:null;
 sendRead(res,prompt,1,"menu",audio);
 return true;
}

// ---------------------------------------------------------------------------
// Tishl (IVR path 1591, Olam Chesed calling desk).
// Voice-prompt keys: the staging gavhah_yemot_voice_prompts CHECK constraint
// was relaxed 2026-11-19 to allow one trailing lowercase letter, so keys
// like '1591a' ARE stored (24 Tishl drafts, all published_path NULL).
// Key map (see ~/workspace/yiddish-tts/tishl-phrases.json):
//   '1591'  = welcome (NOT spoken by the handler — entering Tishl plays the
//             queue immediately, per Yakob's spec; the draft is voice-studio
//             stock). '1591a'+'1591b' = action menu parts 1+2.
//   '1591c' = navigation hint (built into describeTishlItem instead).
//   '1591d' = date choice. '1591e' = note saved. '1591f' = queue empty.
//   '1591k' = done. '1591l' = deleted. '1591m' = reminder saved.
//   '1591n' = held. '1591o' = hold released. '1591u' = calling now (unused:
//             the dial handoff speaks its own longer text). '1591v' = end of
//             queue. '1591w' = confirm delete ("press 3 again").
// Every helper returns a safe fallback when the table has no row.
// ---------------------------------------------------------------------------

/** Optional voice-prompt override from gavhah_yemot_voice_prompts. Never throws. */
async function tishlVoicePrompt(client:PoolClient,key:string):Promise<string|null>{
 try{
  const r=await client.query<{tts_text:string}>(
   "SELECT tts_text FROM public.gavhah_yemot_voice_prompts WHERE path=$1",[key]);
  const t=r.rows[0]?.tts_text;
  return typeof t==="string"&&t.trim()?t.trim():null;
 }catch{return null;}
}

/** Extra spoken detail for a queue item (task priority/deadline, case status/urgency). */
async function tishlItemExtra(client:PoolClient,item:TishlQueueItem):Promise<string>{
 if(item.kind==="task"){
  const r=await client.query<{priority:string;deadline:string|null}>(
   "SELECT priority,deadline FROM public.askanus_tasks WHERE id=$1",[item.id]);
  const x=r.rows[0];if(!x)return "";
  return "Priority "+safeVoice(x.priority,20)+". "+(x.deadline?"Due "+safeVoice(x.deadline,28)+". ":"");
 }
 if(item.kind==="case"){
  const r=await client.query<{status:string;urgency:string}>(
   "SELECT status,urgency FROM public.askanus_cases WHERE id=$1",[item.id]);
  const x=r.rows[0];if(!x)return "";
  return "Status "+safeVoice(x.status,20)+". Urgency "+safeVoice(x.urgency,20)+". ";
 }
 return "";
}

/** Index of a task/case in the newest-first personal list (same order as myPrompt). */
async function findPersonalIndex(client:PoolClient,userId:number,kind:"task"|"case",id:number):Promise<number>{
 const table=kind==="task"?"askanus_tasks":"askanus_cases";
 const r=await client.query<{id:number}>(
  "SELECT id FROM public."+table+" WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200",[userId]);
 const idx=r.rows.findIndex((x)=>x.id===id);
 return idx>=0?idx:0;
}

/** After a removal (done/delete/remind), re-fetch the queue and clamp the position. */
async function tishlAdvanceAfterRemoval(client:PoolClient,userId:number,st:TishlState):Promise<{state:TishlState|null;empty:boolean}>{
 const fresh=await getTishlQueue(client,userId);
 if(!fresh.length)return{state:null,empty:true};
 // The next item slides into the same index; if the removed item was the
 // last one, the position lands past the end ("end of queue").
 if(st.pos>=fresh.length)st.pos=fresh.length;
 const cur=fresh[st.pos]||null;
 st.kind=cur?cur.kind:null;st.id=cur?cur.id:null;
 return{state:st,empty:false};
}

/**
 * Missed-call return-call handoff.
 *
 * AVOID ROUTE (staging): staging max_return_calls is missing the columns
 * purpose_text, agent_display_name, selected_digit and expires_at that
 * signalwire-max-return-calls.ts selects, so this handoff never touches
 * that table or its code paths. It uses only max_call_sessions plus
 * placeOlamMaxOutboundCall (signalwire-max-outbound.ts).
 *
 * How it works: the existing outbound mechanism calls the AGENT's verified
 * phone first (SignalWire REST API), then bridges to the missed caller.
 * The IVR response itself can never dial. The agent's phone will ring
 * while they are on the IVR call (likely the same handset -> call waiting);
 * a real return call from the IVR has never been placed and needs a
 * physical test. The number is tried as a US number first, then once as
 * a Canadian number if the provider rejects the US guess.
 * On Yemot (not fromShared) no call is placed: the existing notice is spoken.
 */
async function tishlReturnCall(client:PoolClient,userId:number,item:TishlQueueItem,fromShared:boolean):Promise<string>{
 if(!fromShared)return "This phone menu cannot place calls. To call this number back, use the Olam Chesed calling line. ";
 const raw=String(item.phone||"");
 const digits=raw.replace(/\D/g,"");
 const national=digits.length===11&&digits.startsWith("1")?digits.slice(1):digits;
 const e164=/^[2-9]\d{2}[2-9]\d{6}$/.test(national)?"+1"+national:null;
 if(!e164)return "The number for this missed call is not a valid United States or Canada number. Nothing was dialed. ";
 // The prepared row MUST be committed before placeOlamMaxOutboundCall
 // reads it: that function queries through pool, which can never see a
 // row inserted inside this request's open transaction (it would 409
 // "Call is missing or already claimed"). So insert on a dedicated
 // autocommit client, not the txn client. Same fix as the Calling dial.
 const direct=await pool.connect();
 let sessionId:string;
 try{
  const ins=await direct.query<{id:string}>(
   "INSERT INTO public.max_call_sessions(user_id,number_e164,destination_country,direction,status,provider) "+
   "VALUES($1,$2,'US','outbound','prepared','signalwire') RETURNING id",[userId,e164]);
  sessionId=ins.rows[0].id;
 }finally{direct.release();}
 for(const country of ["US","CA"] as const){
  try{
   // No campaign ids exist in Tishl, so authorizeCampaign is a stub that
   // is never called; the session is agent-initiated.
   await placeOlamMaxOutboundCall(userId,sessionId,async()=>({phone:"",authorized:false}));
   return "Your verified phone is ringing now. Answer it, and you will be connected to the caller. ";
  }catch(err){
   const msg=String((err as {message?:unknown})?.message||"");
   if(country==="US"&&/could not verify US\/Canada destination/i.test(msg)){
    // The provider rejected the US guess; retry once as Canada on the same session.
    // pool.query, not the txn client (see the insert above).
    await pool.query("UPDATE public.max_call_sessions SET destination_country='CA' WHERE id=$1",[sessionId]);
    continue;
   }
   return "The return call could not be started. "+(msg?safeVoice(msg,120)+" ":"");
  }
 }
 return "The return call could not be started. ";
}

// ---------------------------------------------------------------------------
// Calling (IVR path 1592, Olam Chesed option 2 "Call-2").
// Voice-prompt keys (same gavhah_yemot_voice_prompts lookup as Tishl;
// the copy reads PROD, the drafts live on STAGING, so every lookup misses
// and the English fallback is used — correct until publishing is approved).
// Key map (fallbacks are the calling-phone.ts machine helpers):
//   '1592'  = top menu (callingMenuSpeech; SignalWire 1-7, Yemot 2-7).
//   '1592a' = call-log filter menu. '1592b' = log-item detail menu.
//   '1592c' = missed-call detail menu. '1592d' = contact menu.
//   '1592e' = edit field menu. '1592f' = edit value (record note) prompt.
//   '1592g' = select-case prompt. '1592h' = phone entry.
//   '1592i' = fill outcome. '1592j' = fill amount. '1592k' = fill note.
//   '1592l' = fill mood. '1592m' = date choice. '1592n' = date year.
//   '1592o' = confirm delete ("press 3 again").
//   '1592p' = confirm delete-all ("press 3 again").
//   '1592q' = list empty. '1592r' = end of list.
//   '1592s' = call result saved. '1592t' = call information updated.
//   '1592u' = dial success ("Your verified phone is ringing now...").
//   '1592v' = Yemot no-dial notice ("use the calling line").
//   '1592w' = fill method (how? — method label only, never card data).
//   '1592x' = fill paid (pledge paid full / part / not yet).
//   '1592y' = fill paid amount. '1592z' = pickup address (record note).
// No prompt rows are written here. Date day/month/hour/minute prompts are
// inline English (same as the Tishl render) — they have no dedicated keys.
//
// Categories (IVR path 1593, Olam Chesed option 3 "Categories").
// Voice-prompt keys (same gavhah_yemot_voice_prompts lookup):
//   '1593'  = top menu (categoriesMenuSpeech: 5 dimensions).
//   '1593a' = amount entry. '1593b' = list empty. '1593c' = end of list.
// Value/contact lines are dynamic (data), spoken as English text.
// ---------------------------------------------------------------------------

/** Optional voice-prompt override from gavhah_yemot_voice_prompts. Never throws. */
async function callingVoicePrompt(client:PoolClient,key:string):Promise<string|null>{
 try{
  const r=await client.query<{tts_text:string}>(
   "SELECT tts_text FROM public.gavhah_yemot_voice_prompts WHERE path=$1",[key]);
  const t=r.rows[0]?.tts_text;
  return typeof t==="string"&&t.trim()?t.trim():null;
 }catch{return null;}
}

/** The Yemot no-dial notice (key '1592v'). Spoken whenever a dial/redial
 *  is refused on Yemot; the machine already refuses it, this is the
 *  engine's defense in depth for a redial effect arriving anyway. */
async function callingNoDialNotice(client:PoolClient):Promise<string>{
 return (await callingVoicePrompt(client,"1592v"))||
  "This menu cannot place calls. To call this number back, use the calling line. ";
}

type CallingPending =
 |{kind:"fill-note"}
 |{kind:"contact-note";pos:number;field:"name"|"address"|"note";contactId:number}
 |{kind:"pickup-address";contactId:number}
 |null;

/**
 * Extras the engine keeps beside the "calling" key in action_flash:
 * the max_call_sessions id for the fill form in progress (dial time for
 * option 1, manual-log time for option 2) and a pending voice-note
 * recording (the machine has no record mode of its own, so the engine
 * holds the pending recording across the "rr" turn). The pure machine
 * (calling-phone.ts) knows nothing about these; parseCallingFlash reads
 * only the "calling" key from the same JSON.
 */
function parseCallingExtras(manualFlash:string|null|undefined):{sessionId:number|null;pending:CallingPending}{
 try{
  const parsed=JSON.parse(manualFlash||"") as {callingSessionId?:unknown;callingPending?:unknown};
  if(!parsed||typeof parsed!=="object")return{sessionId:null,pending:null};
  const sessionId=typeof parsed.callingSessionId==="number"&&Number.isSafeInteger(parsed.callingSessionId)&&parsed.callingSessionId>0
   ?parsed.callingSessionId:null;
  let pending:CallingPending=null;
  const p=parsed.callingPending;
  if(p&&typeof p==="object"){
   const q=p as {kind?:unknown;pos?:unknown;field?:unknown;contactId?:unknown};
   if(q.kind==="fill-note")pending={kind:"fill-note"};
   else if(q.kind==="pickup-address"&&typeof q.contactId==="number")
    pending={kind:"pickup-address",contactId:q.contactId};
   else if(q.kind==="contact-note"&&typeof q.pos==="number"&&typeof q.contactId==="number"&&
    (q.field==="name"||q.field==="address"||q.field==="note"))
    pending={kind:"contact-note",pos:q.pos,field:q.field,contactId:q.contactId};
  }
  return{sessionId,pending};
 }catch{return{sessionId:null,pending:null};}
}

function encodeCallingFlashFull(state:CallingState,sessionId:number|null,pending:CallingPending):string{
 const out:{calling:CallingState;callingSessionId?:number;callingPending?:CallingPending}={calling:state};
 if(sessionId)out.callingSessionId=sessionId;
 if(pending)out.callingPending=pending;
 return JSON.stringify(out);
}

/**
 * The list the machine indexes for the current mode/option, plus the
 * case/campaign/project picker (used by select-case mode and by effect
 * resolution). Lists are newest-first, same order the machine speaks.
 * - select-case mode: the picker (cases, then campaigns, then projects).
 * - option 3: the full call log; option 4: open missed calls;
 *   option 5: the call log under the chosen filter;
 *   option 7: the contact book (10 per page, first page).
 * - every other mode: no list (phone / fill / date entry).
 */
async function loadCallingList(client:PoolClient,userId:number,state:CallingState):Promise<{items:CallingItemView[];cases:CaseProjectRow[]}>{
 const cases=state.mode==="select-case"?await getOpenCasesAndProjects(client,userId):[];
 if(state.mode==="select-case")return{items:[],cases};
 if(state.option===3)return{items:await getCallLog(client,userId,"all"),cases};
 if(state.option===4)return{items:await getMissedCalls(client,userId),cases};
 if(state.option===5)return{items:await getCallLog(client,userId,state.filter||"all"),cases};
 if(state.option===7){
  const contacts=await getCallingContacts(client,userId,0);
  return{items:contacts.map((c)=>({kind:"contact" as const,id:c.id,
   title:c.name,detail:(c.city?c.city+" ":"")+(c.contact_role||""),phone:c.phone,created_at:c.updated_at})),cases};
 }
 return{items:[],cases};
}

/** A picked case/campaign/project as the persisted purpose (Yakob
 * 23:33: the pick MUST be persisted — never treated like a skip). */
function pickedToPurpose(picked:CaseProjectRow|null):CallPurpose|null{
 if(!picked)return null;
 return{type:picked.kind,key:String(picked.id)};
}

/**
 * AUTO-CONTACT (Yakob 23:09): every number entered becomes a contact
 * (number only; name stays blank). Best-effort: it must never fail the
 * call — a contact failure is swallowed and the call continues.
 */
async function autoContactBestEffort(userId:number,phone:string|null):Promise<number|null>{
 if(!phone)return null;
 const direct=await pool.connect();
 try{
  const ensured=await ensureContactByPhone(direct,userId,phone);
  return ensured.id;
 }catch{
  return null;
 }finally{
  direct.release();
 }
}

/**
 * The lists the categories machine indexes: the values of the current
 * dimension (values mode) and the contacts of the current value
 * (list mode; amount mode resolves by the entered amount).
 */
async function loadCategoriesList(client:PoolClient,userId:number,state:CategoriesState):Promise<{values:CategoryValue[];contacts:CategoryContact[]}>{
 if(state.mode==="values"&&state.dimension&&state.dimension!=="amount"){
  return{values:await getCategoryValues(client,userId,state.dimension),contacts:[]};
 }
 if(state.mode==="list"&&state.dimension){
  if(state.dimension==="amount"&&typeof state.amount==="number"){
   return{values:[],contacts:await getCategoryContacts(client,userId,"amount",String(state.amount))};
  }
  const values=await getCategoryValues(client,userId,state.dimension);
  const value=values[state.valuePos??0]||null;
  if(!value)return{values,contacts:[]};
  return{values,contacts:await getCategoryContacts(client,userId,state.dimension,value.key)};
 }
 return{values:[],contacts:[]};
}

/** Match a phone number to the member's contact book (last 10 digits). */
async function findCallingContact(client:PoolClient,userId:number,phone:string|null):Promise<{id:number;name:string}|null>{
 if(!phone)return null;
 const digits=phone.replace(/\D/g,"").slice(-10);
 if(digits.length!==10)return null;
 const r=await client.query<{id:number;name:string}>(
  "SELECT id,name FROM public.communication_contacts WHERE user_id=$1 AND archived_at IS NULL AND hidden_at IS NULL "+
  "AND RIGHT(regexp_replace(phone,'[^0-9]','','g'),10)=$2 ORDER BY updated_at DESC,id DESC LIMIT 1",[userId,digits]);
 return r.rows[0]||null;
}

/**
 * Dial one prepared session via the MAX outbound path (tishlReturnCall
 * pattern: US first, once as Canada if the provider rejects the US guess).
 * Returns the spoken outcome; never throws for a dial refusal — the
 * caller still goes to the fill-in form for the session.
 * The OLAM_SIGNALWIRE_CALLING_ENABLED switch stays OFF, so while it is
 * off this returns the honest 503 "not active" message; nothing is faked.
 */
async function callingDialSession(client:PoolClient,userId:number,sessionId:number):Promise<string>{
 for(const country of ["US","CA"] as const){
  try{
   await placeOlamMaxOutboundCall(userId,String(sessionId),async()=>({phone:"",authorized:false}));
   return (await callingVoicePrompt(client,"1592u"))||
    "Your verified phone is ringing now. Answer it, and you will be connected. ";
  }catch(err){
   const msg=String((err as {message?:unknown})?.message||"");
   if(country==="US"&&/could not verify US\/Canada destination/i.test(msg)){
    // pool.query, NOT the txn client: placeOlamMaxOutboundCall reads the
    // session through pool, so it must see the committed CA retry.
    await pool.query("UPDATE public.max_call_sessions SET destination_country='CA' WHERE id=$1",[sessionId]);
    continue;
   }
   return "The call could not be started. "+(msg?safeVoice(msg,120)+" ":"");
  }
 }
 return "The call could not be started. ";
}

/**
 * Create a manual-log session on its own client, committed immediately.
 * saveReport / updateReport run under SAVEPOINT calling_effect, and a
 * failed insertCallReport / upsertCallReport rolls back to it — a manual
 * session created on the txn client would be wiped by that rollback,
 * leaving updateSessionFill with no row to hold the fill-in on (live
 * failure with 0 open cases: "could not be saved" although the caller
 * did everything right). Same pattern as the dial branch, which commits
 * its prepared session on a direct client for the same reason.
 */
async function insertManualSessionCommitted(userId:number,phone:string,opts:{provider?:"yemot"|"signalwire";direction?:"outbound"|"inbound";contactId?:number|null;purpose?:CallPurpose|null}):Promise<{sessionId:number;manualRequestId:string}>{
 const direct=await pool.connect();
 try{return await insertManualSession(direct,userId,phone,opts);}
 finally{direct.release();}
}

/** After a removal, re-fetch the list and clamp the position (Tishl pattern). */
async function callingAdvanceAfterRemoval(client:PoolClient,userId:number,st:CallingState):Promise<{state:CallingState;empty:boolean}>{
 const {items}=await loadCallingList(client,userId,st);
 if(!items.length)return{state:{...st,mode:"menu",option:0,pos:0,kind:null,id:null},empty:true};
 const c=clampCallingPosAfterRemoval(st.pos,items.length);
 st.pos=c.pos;
 const cur=items[st.pos]||null;
 st.kind=cur?cur.kind:null;st.id=cur?cur.id:null;
 return{state:st,empty:false};
}

// ---------------------------------------------------------------------------
// TRUE MENU login gate (IVR path 120, live v117).
// Passwords are scrypt with a random salt, so there is no PIN lookup: the
// gate verifies a 6-12 digit password against the phone-registered members
// only (gavhah_phone_member_logins — the only accounts with a phone
// password), bounded (LIMIT 200, ~5s wall-clock guard). Website-only
// members use their 8-digit pairing code instead (same redemption as path
// 125). The raw password is NEVER stored: on a multi-match the gate asks
// for the 4-digit member ID first and re-asks the password afterwards.
// ---------------------------------------------------------------------------

/** Scrypt-verify a password against every phone-registered member. */
async function findPhonePasswordMatches(client:PoolClient,password:string):Promise<{matches:number[];truncated:boolean}>{
 const r=await client.query<{id:number;password_hash:string}>(
  "SELECT u.id, u.password_hash FROM public.users u "+
  "JOIN public.gavhah_phone_member_logins l ON l.user_id=u.id "+
  "WHERE u.status='active' AND u.password_hash LIKE '%:%' ORDER BY u.id DESC LIMIT 200");
 const matches:number[]=[];
 const deadline=Date.now()+5000;
 let truncated=false;
 for(const row of r.rows){
  if(Date.now()>deadline){truncated=true;break;}
  if(await verifyPassword(password,row.password_hash))matches.push(row.id);
 }
 return{matches,truncated};
}

/** Resolve a 4-digit phone member number (member_no / short_member_no). */
async function resolvePhoneMemberByShortId(client:PoolClient,shortId:string):Promise<number|null>{
 const r=await client.query<{user_id:number}>(
  "SELECT user_id FROM public.gavhah_phone_member_logins WHERE member_no=$1 OR short_member_no=$1",
  [shortId]);
 if(!r.rows[0])return null;
 const u=await client.query<{id:number}>(
  "SELECT id FROM public.users WHERE id=$1 AND status NOT IN ('banned','suspended')",[r.rows[0].user_id]);
 return u.rows[0]?.id??null;
}

/** Scrypt-verify a password for one known user. */
async function verifyPasswordForUser(client:PoolClient,userId:number,password:string):Promise<boolean>{
 const r=await client.query<{password_hash:string}>(
  "SELECT password_hash FROM public.users WHERE id=$1 AND status NOT IN ('banned','suspended')",[userId]);
 const stored=r.rows[0]?.password_hash;
 return !!stored&&await verifyPassword(password,stored);
}

/** Redeem an 8-digit website pairing code (same rules as path 125). */
async function redeemPairingCode(client:PoolClient,code:string):Promise<number|null>{
 if(!/^\d{8}$/.test(code))return null;
 const key=process.env.YEMOT_ENCRYPTION_KEY||"";
 if(key.length<36)return null;
 const digest=createHmac("sha256",key).update("gavhah-phone-link-v1:"+code).digest("hex");
 const used=await client.query<{user_id:number}>(
  "UPDATE public.gavhah_phone_pair_codes SET redeemed_at=now() "+
  "WHERE code_hash=$1 AND redeemed_at IS NULL AND expires_at>now() AND user_id IN "+
  "(SELECT id FROM public.users WHERE status NOT IN ('banned','suspended')) RETURNING user_id",[digest]);
 return used.rows[0]?.user_id??null;
}

export async function handleYemotApp(req:Request,res:Response,tree:Record<string,TreeNode>):Promise<void>{
 if(await tryFastYemotRoot(req,res,tree))return;
 const from4444=req.path.endsWith("/4444");
 const fromShared=req.path.endsWith("/shared-ivr");
 const fromNext=req.path.endsWith("/next-ivr")||fromShared;
 // Speed (2026-11-20): the install lookup inside exactSecret and the
 // global enabled check are independent single-row reads — fetch them
 // concurrently instead of one after another. exactSecret stays the
 // single authority for the secret; the global row is only consulted
 // when the secret is valid, exactly as before.
 const [secret,active]=await Promise.all([
  exactSecret(req),
  !fromNext?pool.query("SELECT enabled,last_verified_at FROM public.gavhah_yemot_global WHERE id=1"):Promise.resolve(null),
 ]);
 if(!secret){res.status(403).type("text/plain").send("Access denied");return;}
 if(!fromNext){
  if(!active?.rows[0]?.enabled||!active?.rows[0]?.last_verified_at){
   res.status(503).type("text/plain").send("Hotline integration not enabled");return;
  }
 }
 // NOTE: the old campaign4444 fork is gone (TRUE MENU). The true root is
 // served regardless of campaign state; 4444 is a root digit that returns
 // go_to_folder=/4444 (see the root-map branch below). No install query
 // is needed here anymore.
 const call=sourceCallId(req);
 if(!call){res.type("text/plain").send("id_list_message="+voice("Call identifier missing. Please try again."));return;}
 const callHash=createHmac("sha256",secret).update(call).digest("hex");
 if(fromNext&&!fromShared){
  // One hashed, unique provider call per isolated TEST generation.
  const config=await pool.query("SELECT generation,stage FROM public.gavhah_hotline_migration WHERE id=1");
  const record=config.rows[0];
  if(record?.stage!=="testing"){res.status(503).type("text/plain").send("Test disabled");return;}
  const found=await pool.query(
   "INSERT INTO public.gavhah_hotline_migration_probes(generation,call_hash) VALUES($1,$2) "+
   "ON CONFLICT DO NOTHING RETURNING call_hash",[record.generation,callHash]);
  if(found.rowCount)await pool.query(
   "UPDATE public.gavhah_hotline_migration SET tested_calls=tested_calls+1,last_test_at=now() "+
   "WHERE id=1 AND stage='testing' AND generation=$1",[record.generation]);
 }
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const r=await client.query<State>("INSERT INTO public.gavhah_yemot_call_states(call_hash) VALUES($1) ON CONFLICT(call_hash) DO UPDATE SET updated_at=now() RETURNING step,path,news_position,news_chunk,member_id,linked_until,login_failures,phone_page,selected_item_id,news_actions_open,news_reply_mode,news_reply_target,news_report_mode,action_flash",[callHash]);
  let s=r.rows[0],{step,path,news_position:position,news_chunk:chunk,phone_page:page,selected_item_id:confirmId}=s;
  if(from4444 && step===0 && !path)path="2";
  let userId=s.member_id;
  let actionsOpen=s.news_actions_open,replyMode=s.news_reply_mode,replyTarget=s.news_reply_target,reportMode=s.news_report_mode;
  let manualFlash=s.action_flash||"";
  let tishlState:TishlState|null=parseTishlFlash(manualFlash);
  let callingState:CallingState|null=parseCallingFlash(manualFlash);
  let categoriesState:CategoriesState|null=parseCategoriesFlash(manualFlash);
  let callingExtras=parseCallingExtras(manualFlash);
  let callingSessionId:number|null=callingExtras.sessionId;
  let callingPending:CallingPending=callingExtras.pending;
  if(step>9000){step=0;path="";position=0;chunk=0;page=0;confirmId=null;actionsOpen=false;replyMode=false;replyTarget=null;reportMode=false;manualFlash="";tishlState=null;callingState=null;categoriesState=null;callingSessionId=null;callingPending=null;}
  // Tishl date entry uses the "ar" (article, up to 8 digits) input name and
  // Tishl voice notes use the "rr" (record) input name. Calling reuses both:
  // its date/phone/amount modes are multi-digit ("ar", accumulated by the
  // machine across reads) and its voice notes use "rr" via callingPending.
  const tishlDateEntry=!!tishlState&&(tishlState.mode==="date-day"||tishlState.mode==="date-month"||tishlState.mode==="date-hour"||tishlState.mode==="date-minute");
  const callingMultiDigit=!!callingState&&["date-day","date-month","date-year","date-hour","date-minute","phone","fill-amount","fill-paid-amount"].includes(callingState.mode);
  const categoriesMultiDigit=!!categoriesState&&categoriesState.mode==="amount-entry";
  const inputName=(tishlState?.mode==="note"||callingPending||replyMode?"rr":tishlDateEntry||callingMultiDigit||categoriesMultiDigit?"ar":path==="125"?"ln":path==="185"||path===GATE_PATH?"rg":(path==="115"||path==="97022"||publicIdSections.has(path))&&!confirmId&&!actionsOpen?"ar":"iv")+step;
  const raw=req.body?.[inputName]??req.query[inputName]??(fromNext?req.body?.signalwireDigits:undefined);
  let feedback="";
  let goToCampaignExtension=false;
  let goToFolder64=false;
  // Gate audio key (120a–120j): set by the gate digit/render branches
  // below; resolved to a published recording after the render. When a
  // recording is published for the key, the caller hears pinchas audio
  // instead of the English gate text.
  let gateAudioKey: string|null=null;
  // Published pinchas audio for THIS turn's prompt (set by voicePrompt
  // below, by the gate resolution, or by the navigational-menu override
  // after the render). sendRead plays it instead of the TTS text.
  // Declared here (before the render branches) so the render can set it.
  let publishedAudio: string|null=null;
  // Build B: a news/discussion recording for THIS turn (set by the
  // content branches below). On Yemot it plays instead of the text;
  // contentAudioPrefix (headline + keys) is spoken before the file.
  // SignalWire always hears the text.
  let contentAudio: string|null=null;
  let contentAudioPrefix: string|null=null;
  // Render-branch voice prompt: returns the row's English tts_text (or
  // the fallback), and captures the published pinchas recording for the
  // key so this turn plays audio instead of TTS. Used ONLY where the
  // spoken text IS the key's prompt (a static menu-like prompt): never
  // where the turn also speaks dynamic content (a case title, the date
  // + Parsha, a two-part menu), and never for digit-branch feedback,
  // which shares its turn with the following menu/list prompt.
  // NEVER plays audio for 1592/1592a/1592b: those JSON rows would replace
  // the provider-generated menu (offering option 1, make a call, on
  // Yemot) — see load-true-menu-drafts.js.
  const voicePrompt = async (key: string, fallback: string): Promise<string> => {
   const o = await phonePromptOverride(key);
   if (o.audioPath && key !== "1592" && key !== "1592a" && key !== "1592b") publishedAudio = o.audioPath;
   return o.ttsText || fallback;
  };
  if(raw!==undefined&&raw!==null){
   const digit=String(raw).trim();
   // Existing Yemot management is usually extension /0 (admin_login).
   // Preserve it on root 0, and keep nested 0 returning to the API root.
   // Moving to /0 DOES NOT bypass the provider admin password.
   // Path 1591 (Tishl) handles its own 0: back one level, or leave Tishl.
   // Path 1592 (Calling) handles its own 0 the same way (the machine
   // treats 0 as back, except where 0 is a digit: phone/amount/hour/minute).
   // Path 1593 (Categories) handles its own 0 the same way.
   // The news/discussions lists and their insert menus handle 0
   // themselves (0 = insert menu in a list, 0 = main menu in an insert
   // menu), so they are excluded here — otherwise 0 would slice one
   // digit off the path (back one level) before their branch runs.
   if(digit==="0" && path!=="" && path!=="1591" && path!=="1592" && path!=="1593" && !newsPath(path) && path!=="116" && path!=="97021" && path!=="97020" && !fromShared){
    if(path==="185")await cancelPhoneSignup(client,callHash);
    // The gate (120) and every 97xx department return straight to the
    // root: slicing one digit would land on a structural tree node
    // ("970", "12") that no caller should ever hear.
    if(path===GATE_PATH||path.startsWith("97"))path="";
    else path=path.length>2?path.slice(0,-1):(from4444?"2":"");
    position=0;chunk=0;page=0;confirmId=null;
    actionsOpen=false;replyMode=false;replyTarget=null;reportMode=false;manualFlash="";feedback="";
   }else if(from4444 && digit==="0"){
    path="2";position=0;chunk=0;page=0;confirmId=null;actionsOpen=false;replyMode=false;reportMode=false;
   }else if(path===GATE_PATH){
    // TRUE MENU login gate (live v117): 6-12 digit member password,
    // member ID only when required. This digit branch composes the FULL
    // spoken message (status + prompt); the render below appends the
    // prompt only when feedback is empty (first entry to the gate).
    const gate=parseGateFlash(manualFlash);
    const failOnce=():boolean=>{
     s.login_failures++;
     if(s.login_failures>=5){path="";manualFlash="";feedback=gateText(GATE_LOCKED_YI,GATE_LOCKED_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("locked");return true;}
     return false;
    };
    const loginOk=(target:string,uid:number)=>{
     userId=uid;s.member_id=uid;s.login_failures=0;
     s.linked_until=new Date(Date.now()+30*60*1000).toISOString();
     manualFlash="";feedback=gateText(GATE_WELCOME_YI,GATE_WELCOME_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("welcome");
     if(target===GATE_TARGET_4444){goToCampaignExtension=true;path="";}
     else path=target;
     position=0;chunk=0;page=0;confirmId=null;
    };
    if(!gate){path="";manualFlash="";feedback="";}
    else if(s.login_failures>=5){path="";manualFlash="";feedback=gateText(GATE_LOCKED_YI,GATE_LOCKED_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("locked");}
    else if(gate.needId){
     if(/^\d{4}$/.test(digit)){
      const resolved=await resolvePhoneMemberByShortId(client,digit);
      if(!resolved){if(!failOnce()){feedback=gateText(GATE_WRONG_ID_YI,GATE_WRONG_ID_EN,fromShared)+" "+gateText(GATE_NEED_ID_YI,GATE_NEED_ID_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("wrongIdNeedId");}}
      else{gate.needId=false;gate.pendingUser=resolved;manualFlash=encodeGateFlash(gate);feedback=gateText(GATE_PASSWORD_YI,GATE_PASSWORD_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("password");}
     }else{feedback=gateText(GATE_NEED_ID_YI,GATE_NEED_ID_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("needId");}
    }else if(gate.pendingUser){
     if(/^\d{6,12}$/.test(digit)){
      if(await verifyPasswordForUser(client,gate.pendingUser,digit))loginOk(gate.target,gate.pendingUser);
      else if(!failOnce()){feedback=gateText(GATE_WRONG_YI,GATE_WRONG_EN,fromShared)+" "+gateText(GATE_REPROMPT_YI,GATE_REPROMPT_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("wrongReprompt");}
     }else{feedback=gateText(GATE_PASSWORD_YI,GATE_PASSWORD_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("password");}
    }else if(/^\d{6,12}$/.test(digit)){
     const found=await findPhonePasswordMatches(client,digit);
     if(found.matches.length===1){loginOk(gate.target,found.matches[0]);}
     else if(found.matches.length>1){
      gate.needId=true;manualFlash=encodeGateFlash(gate);
      feedback=gateText(GATE_NEED_ID_YI,GATE_NEED_ID_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("needId");
     }else{
      // No phone password matched: try the 8-digit website pairing code
      // (same redemption as path 125) before failing honestly.
      const codeUser=/^\d{8}$/.test(digit)?await redeemPairingCode(client,digit):null;
      if(codeUser){loginOk(gate.target,codeUser);}
      else if(found.truncated){feedback="The password could not be checked right now. Please try again later. ";}
      else if(!failOnce()){feedback=gateText(GATE_WRONG_YI,GATE_WRONG_EN,fromShared)+" "+gateText(GATE_REPROMPT_YI,GATE_REPROMPT_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("wrongReprompt");}
     }
    }else{feedback=gateText(GATE_REPROMPT_YI,GATE_REPROMPT_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("reprompt");}
   }else if(path==="159" && !fromShared && !from4444){
    // Separate SignalWire permission: provider verification is NEVER inferred
    // from caller ID or from an ordinary Gavhah/MAX account.
    const verified=!!userId&&await memberAllowed(client,{...s,member_id:userId});
    const row=verified?(await client.query<{status:string}>(
     "SELECT status FROM public.gavhah_olam_chesed_access WHERE user_id=$1",[userId])).rows[0]:null;
    if(!verified){
     feedback="To request Olam Chesed access, securely link your website account under My Askanus option 5. ";
    }else if(row?.status==="linked"){
     if(/^[1-9]$/.test(digit))path="159"+digit;
    }else if(digit==="1"){
     if(!row){
      await client.query(
       "INSERT INTO public.gavhah_olam_chesed_access(user_id,reason) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",
       [userId,"Verified phone applicant requests separate Olam Chesed SignalWire account verification and access"]);
      feedback="Your access request was saved for administration review. ";
     }else feedback="Your access request is already on file. ";
    }else feedback="Press 1 to request Olam Chesed SignalWire access. ";
   }else if(path==="1591"){
    // Tishl. Same linked-member + Olam-access gate as the other 159x paths;
    // on SignalWire the digit gate is bypassed via treeSelect, so the gate
    // is checked here again. NOTE: "#" and "*" delivery by Yemot in menu
    // read mode is UNVERIFIED and needs a physical test.
    const verified=!!userId&&await memberAllowed(client,{...s,member_id:userId});
    const accessRow=verified?(await client.query<{status:string}>(
     "SELECT status FROM public.gavhah_olam_chesed_access WHERE user_id=$1",[userId])).rows[0]:null;
    if(!verified||accessRow?.status!=="linked"){
     path="159";tishlState=null;page=0;confirmId=null;
     feedback="Your Olam Chesed access is not linked. ";
    }else if(tishlState?.mode==="note"){
     // The "digit" is the recording Yemot/SignalWire just stored (rr input).
     // saveVoiceNewsReply's storage pattern is reused for the recording
     // reference itself: a valid ivr2: path is kept as-is; any other
     // non-empty reference is stored too (SignalWire's form is unknown),
     // and the website can play it from tishl_notes.
     const ref=typeof digit==="string"?digit.trim():"";
     const noteKind=tishlState.kind,noteId=tishlState.id;
     if(!noteKind||!noteId){
      tishlState.mode="action";feedback="The voice note was not saved. ";
     }else if(!ref||ref==="None"){
      tishlState.mode="action";feedback="The recording was not accepted. Please try again. ";
     }else{
      const kept=validRecordedPath(ref)||ref;
      await addTishlNote(client,userId!,noteKind,noteId,buildVoiceNoteText(kept,new Date().toISOString()));
      tishlState.mode="listen";feedback=(await tishlVoicePrompt(client,"1591e"))||"Your voice note is saved on this item. ";
     }
    }else{
     if(!tishlState)tishlState=newTishlState();
     const queue=await getTishlQueue(client,userId!);
     const acted=queue[tishlState.pos]||null;
     if(acted){tishlState.kind=acted.kind;tishlState.id=acted.id;}
     else{tishlState.kind=null;tishlState.id=null;}
     const result=handleTishlDigit(tishlState,digit,queue.length,new Date(),TISHL_TZ);
     tishlState=result.state;feedback+=result.feedback;
     if(result.effect.type==="leave"){
      path="159";tishlState=null;page=0;confirmId=null;
     }else if(result.effect.type==="done"&&acted){
      await markTishlDone(client,userId!,acted.kind,acted.id);
      feedback+=(await tishlVoicePrompt(client,"1591k"))||"Marked done. ";
      const adv=await tishlAdvanceAfterRemoval(client,userId!,tishlState);
      if(adv.empty){path="159";tishlState=null;page=0;confirmId=null;feedback+="Your Tishl is now empty. ";}
      else tishlState=adv.state;
     }else if(result.effect.type==="delete"&&acted){
      await deleteTishlItem(client,userId!,acted.kind,acted.id);
      feedback+=(await tishlVoicePrompt(client,"1591l"))||"Deleted. ";
      const adv=await tishlAdvanceAfterRemoval(client,userId!,tishlState);
      if(adv.empty){path="159";tishlState=null;page=0;confirmId=null;feedback+="Your Tishl is now empty. ";}
      else tishlState=adv.state;
     }else if(result.effect.type==="hold"&&acted){
      const held=await toggleTishlHold(client,userId!,acted.kind,acted.id);
      feedback+=held?((await tishlVoicePrompt(client,"1591n"))||"This item is now on hold. It stays on your Tishl. "):((await tishlVoicePrompt(client,"1591o"))||"Hold released. ");
     }else if(result.effect.type==="remind"&&acted){
      await setTishlReminder(client,userId!,acted.kind,acted.id,result.effect.at);
      feedback+=(await tishlVoicePrompt(client,"1591m"))||"Reminder saved. ";
      const adv=await tishlAdvanceAfterRemoval(client,userId!,tishlState);
      if(adv.empty){path="159";tishlState=null;page=0;confirmId=null;feedback+="Your Tishl is now empty. ";}
      else tishlState=adv.state;
     }else if(result.effect.type==="contextual"&&acted){
      if(acted.kind==="missed_call"){
       feedback+=await tishlReturnCall(client,userId!,acted,fromShared);
      }else if(acted.kind==="scheduled_call"){
       // Calling option 6: the scheduled call's number is on the item as
       // number_e164. SignalWire-only, as today — on Yemot tishlReturnCall
       // speaks the existing "cannot place calls" notice.
       feedback+=await tishlReturnCall(client,userId!,acted,fromShared);
      }else if(acted.kind==="task"||acted.kind==="case"){
       // Jump to the Tasks/Cases section at this item's index, newest-first.
       page=await findPersonalIndex(client,userId!,acted.kind,acted.id);
       path=acted.kind==="task"?"121":"122";confirmId=null;tishlState=null;
       feedback+=acted.kind==="task"?"Opening your tasks. ":"Opening your cases. ";
      }
     }
     if(tishlState&&(result.effect.type==="none"||result.effect.type==="contextual"||result.effect.type==="hold")){
      const cur=queue[tishlState.pos]||null;
      tishlState.kind=cur?cur.kind:null;tishlState.id=cur?cur.id:null;
     }
    }
   }else if(path==="1592"){
    // Calling. Same linked-member + Olam-access gate as 1591; on
    // SignalWire the digit gate is bypassed via treeSelect, so the gate
    // is checked here again.
    const verified=!!userId&&await memberAllowed(client,{...s,member_id:userId});
    const accessRow=verified?(await client.query<{status:string}>(
     "SELECT status FROM public.gavhah_olam_chesed_access WHERE user_id=$1",[userId])).rows[0]:null;
    if(!verified||accessRow?.status!=="linked"){
     path="159";callingState=null;callingSessionId=null;callingPending=null;
     feedback="Your Olam Chesed access is not linked. ";
    }else if(callingPending){
     // The "digit" is the recording just stored (rr input): a pending
     // fill-note or contact-note from the previous turn. Validated the
     // same way as Tishl notes (a valid ivr2: path kept as-is, any other
     // non-empty reference stored too; empty/"None" is not accepted).
     const ref=typeof digit==="string"?digit.trim():"";
     if(!ref||ref==="None"){
      callingPending=null;
      feedback="The recording was not accepted. Please try again. ";
     }else{
      const kept=validRecordedPath(ref)||ref;
      const noteText=buildVoiceNoteText(kept,new Date().toISOString());
      if(callingPending.kind==="fill-note"){
       if(callingState)callingState=attachCallingNote(callingState,noteText);
       feedback="Your voice note is saved. ";
      }else if(callingPending.kind==="pickup-address"){
       // The pickup address is a voice note because a keypad cannot
       // type it; on the caller's confirmation it is attached to the
       // contact (the auto-save to contact info). Then the fill form
       // continues at the call's voice note.
       const ok=await addContactNote(client,userId!,callingPending.contactId,noteText);
       if(callingState)callingState=advanceAfterPickupAddress(callingState);
       feedback=ok?"The pickup address is saved with this contact. ":"The pickup address was not saved. ";
      }else{
       const ok=await addContactNote(client,userId!,callingPending.contactId,noteText);
       feedback=ok?"Your voice note is saved with this contact. ":"The voice note was not saved. ";
      }
      callingPending=null;
     }
    }else{
     if(!callingState)callingState=newCallingState();
     const provider=fromShared?"signalwire":"yemot";
     const {items,cases}=await loadCallingList(client,userId!,callingState);
     // Mirror the current item into kind/id (Tishl pattern). The edit
     // flow resets pos, so kind/id are what identify the edited entry
     // when updateReport runs. Select-case must NOT overwrite them: in
     // the edit flow they still name the entry being edited.
     if(["list","detail","contact-menu","confirm-delete","confirm-delete-all"].includes(callingState.mode)){
      const cur=items[callingState.pos]||null;
      callingState.kind=cur?cur.kind:null;callingState.id=cur?cur.id:null;
     }
     const listLength=callingState.mode==="select-case"?cases.length:items.length;
     const result=handleCallingDigit(callingState,digit,{provider,option:callingState.option,listLength},new Date(),CALLING_TZ);
     callingState=result.state;
     const eff:CallingEffect=result.effect;
     const machineFeedback=result.feedback;
     // saveReport / updateReport / toggleDNC speak their own feedback
     // (the machine's text can be wrong when a campaign/project pick
     // could not be attached, or when the contact is gone).
     let effectFeedback=["saveReport","updateReport","toggleDNC"].includes(eff.type)?"":machineFeedback;
     // One savepoint for the whole effect: a failed effect query must
     // not abort the outer transaction (which would 500 the call with
     // no spoken feedback). Recovery paths roll back to it first.
     await client.query("SAVEPOINT calling_effect");
     let advanced=false;
     try{
      if(eff.type==="leave"){
       path="159";callingState=null;callingSessionId=null;callingPending=null;
      }else if(eff.type==="dial"){
       // Option 1 (SignalWire only — the machine never emits this on
       // Yemot). The pick is PERSISTED on the session: a case pick on
       // case_id, any pick (case/campaign/project) on
       // purpose_type/purpose_key — never treated like a skip.
       const picked=await resolveCaseSelection(client,userId!,eff.casePos);
       const caseId=picked&&picked.kind==="case"?picked.id:null;
       const purpose=pickedToPurpose(picked);
       let sessionId:number|null=null;
       try{
        // Committed immediately on its own client (NOT the txn client):
        // placeOlamMaxOutboundCall reads the session through pool and
        // can never see a row from this request's open transaction.
        const direct=await pool.connect();
        try{sessionId=await insertPreparedSession(direct,userId!,eff.phone,{caseId,purpose});}
        finally{direct.release();}
        callingSessionId=sessionId;
       }catch(err){
        effectFeedback+="The call could not be prepared. "+safeVoice(String((err as {message?:unknown})?.message||""),120)+" ";
       }
       if(sessionId!==null){
        // AUTO-CONTACT (Yakob 23:09): the dialled number becomes a
        // contact (number only). Best-effort; never fails the call.
        await autoContactBestEffort(userId!,eff.phone);
        // Dial refusal still goes to the fill-in form (the machine
        // already moved there); the outcome is spoken honestly.
        effectFeedback+=await callingDialSession(client,userId!,sessionId);
       }
      }else if(eff.type==="redial"){
       const item=items[eff.pos]||null;
       if(!item||!item.phone){
        effectFeedback+="This number is not available to call back. ";
       }else if(!fromShared){
        // Defense in depth: the machine never emits redial on Yemot.
        effectFeedback+=await callingNoDialNotice(client);
       }else{
        let sessionId:number|null=null;
        try{
         // Committed immediately on its own client (see the dial branch).
         const direct=await pool.connect();
         try{sessionId=await insertPreparedSession(direct,userId!,item.phone,{});}
         finally{direct.release();}
        }catch(err){
         effectFeedback+="The call could not be prepared. "+safeVoice(String((err as {message?:unknown})?.message||""),120)+" ";
        }
        if(sessionId!==null){
         // AUTO-CONTACT: the redialled number becomes a contact.
         await autoContactBestEffort(userId!,item.phone);
         // No fill form follows a redial (the machine stays in the
         // list); the session is in the log for option 3/5 later.
         effectFeedback+=await callingDialSession(client,userId!,sessionId);
        }
       }
      }else if(eff.type==="saveReport"){
       const report=eff.report;
       // AUTO-CONTACT (Yakob 23:09): the logged number becomes a
       // contact (number only) — before the report is written, so the
       // report can already carry the contact id.
       let ensuredContactId:number|null=null;
       if(report.phone){
        ensuredContactId=await autoContactBestEffort(userId!,report.phone);
       }
       const contact=await findCallingContact(client,userId!,report.phone)
        ?? (ensuredContactId!==null&&report.phone
          ? {id:ensuredContactId,name:report.phone} : null);
       const contactName=contact?contact.name:(report.phone||"Phone call");
       const picked=await resolveCaseSelection(client,userId!,report.casePos);
       const pickedCaseId=picked&&picked.kind==="case"?picked.id:null;
       const purpose=pickedToPurpose(picked);
       const cols=purposeToReportColumns(purpose);
       // The engine must have a session row: dialled flows have one
       // from the dial effect; manual flows create one now (a
       // 'completed' row, never 'prepared', so the dial path can never
       // claim it).
       let sessionId=callingSessionId;
       if(sessionId===null){
        if(report.source==="manual"&&report.phone){
         try{
          const m=await insertManualSessionCommitted(userId!,report.phone,{provider,contactId:contact?contact.id:null,purpose});
          sessionId=m.sessionId;callingSessionId=sessionId;
         }catch(err){
          await client.query("ROLLBACK TO SAVEPOINT calling_effect").catch(()=>{});
          effectFeedback+="The call result could not be saved. "+safeVoice(String((err as {message?:unknown})?.message||""),120)+" ";
         }
        }else{
         effectFeedback+="The call result could not be saved because there is no call record for it. ";
        }
       }
       if(sessionId!==null){
        const draft=sessionFillFromReport(report);
        if(contact)draft.contactName=contact.name;
        else if(report.phone)draft.contactName=report.phone;
        draft.purpose=purpose;
        let saved=false,held=false;
        try{
         // caseId undefined lets insertCallReport try the single open
         // case; it throws (before any write) with 0 or 2+ open cases.
         // A campaign/project pick alone cannot create the report
         // (case_id is NOT NULL): the fill-in is then held on the
         // session WITH the purpose persisted (see below).
         const id=await insertCallReport(client,userId!,{caseId:pickedCaseId??undefined,
          contactId:contact?contact.id:null,contactName,
          outcome:normalizeReportOutcome(report.outcome),
          moneyKind:report.moneyKind??"none",amount:report.amount??null,note:report.note??undefined,mood:report.mood??undefined,
          paymentMethod:report.paymentMethod??null,
          campaignId:cols.campaignId,projectId:cols.projectId,
          pledgeAmount:report.pledgeAmount??null,purpose,
          sessionId});
         saved=id!==null;
        }catch{
         await client.query("ROLLBACK TO SAVEPOINT calling_effect").catch(()=>{});
         saved=false;
        }
        if(!saved){
         // No report: carry the pick on the session itself (case on
         // case_id, any pick on purpose_type/purpose_key, so option 3
         // can still find it) and hold the fill-in on the session
         // until a case is chosen there. Never silently pick one.
         if(pickedCaseId||purpose){
          await client.query("UPDATE public.max_call_sessions SET case_id=COALESCE($1,case_id),purpose_type=COALESCE($4,purpose_type),purpose_key=COALESCE($5,purpose_key),updated_at=now() WHERE id=$2 AND user_id=$3",
           [pickedCaseId,sessionId,userId!,purpose?purpose.type:null,purpose?purpose.key:null]);
         }
         try{held=await updateSessionFill(client,sessionId,userId!,draft);}catch{held=false;}
        }
        if(saved){
         effectFeedback=(await callingVoicePrompt(client,"1592s"))||machineFeedback;
        }else if(held){
         effectFeedback="Call result saved on the call without a case. You can add a case later from option 3, update call information. ";
        }else{
         effectFeedback="The call result could not be saved. Please try again later. ";
        }
       }
      }else if(eff.type==="updateReport"){
       const report=eff.report;
       // The edit flow resets pos, so the target is kind/id (mirrored
       // from the entry before the edit started), not effect.pos.
       const target=callingState.kind&&callingState.id
        ?{kind:callingState.kind,id:callingState.id}
        :items[eff.pos]?{kind:items[eff.pos].kind,id:items[eff.pos].id}:null;
       if(!target){
        effectFeedback="This call entry is no longer available. ";
       }else if(target.kind==="report"){
        const picked=await resolveCaseSelection(client,userId!,report.casePos);
        const purpose=pickedToPurpose(picked);
        const cols=purposeToReportColumns(purpose);
        // Skipped fields keep their stored values (merge semantics,
        // matching upsertCallReport for sessions); a null casePos on a
        // report keeps its current case. A campaign/project pick now
        // lands on campaign_id/project_id instead of being dropped.
        const patch:{caseId?:number;outcome:ReturnType<typeof normalizeReportOutcome>;moneyKind?:"none"|"received"|"pledged";amount?:number;note?:string;mood?:string;paymentMethod?:"credit_card"|"cash"|"check"|"tzedakah_card"|"voucher"|null;campaignId?:number|null;projectId?:number|null;pledgeAmount?:number|null}={
         outcome:normalizeReportOutcome(report.outcome),
         moneyKind:report.moneyKind??undefined,
        };
        if(picked&&picked.kind==="case")patch.caseId=picked.id;
        if(cols.campaignId!==null)patch.campaignId=cols.campaignId;
        if(cols.projectId!==null)patch.projectId=cols.projectId;
        if(report.amount!==null&&report.amount!==undefined)patch.amount=report.amount;
        if(report.note!==null&&report.note!==undefined)patch.note=report.note;
        if(report.mood!==null&&report.mood!==undefined)patch.mood=report.mood;
        if(report.paymentMethod!==undefined)patch.paymentMethod=report.paymentMethod??null;
        if(report.pledgeAmount!==null&&report.pledgeAmount!==undefined)patch.pledgeAmount=report.pledgeAmount;
        let ok=false;
        try{ok=await updateCallReport(client,userId!,target.id,patch);}catch{ok=false;}
        if(ok){
         effectFeedback=(await callingVoicePrompt(client,"1592t"))||machineFeedback;
        }else effectFeedback="This call entry could not be updated. ";
       }else if(target.kind==="session"||target.kind==="missed"){
        let sessionId=target.id;
        if(target.kind==="missed"){
         // A missed call has no session yet: log it as a manual
         // (inbound) session first, then edit that session's fill-in.
         // The pre-call list was the case picker (edit flow), so the
         // missed entry is re-read here instead of using stale items.
         const log=await getCallLog(client,userId!,"all");
         const missed=log.find((x)=>x.kind==="missed"&&x.id===target.id)||null;
         const phone=missed?.phone||null;
         const contact=await findCallingContact(client,userId!,phone);
         if(!phone){
          effectFeedback="This missed call has no number to log. ";
          sessionId=-1;
         }else{
          try{
           const m=await insertManualSessionCommitted(userId!,phone,{provider,direction:"inbound",contactId:contact?contact.id:null});
           sessionId=m.sessionId;
           // AUTO-CONTACT: the missed number becomes a contact.
           await autoContactBestEffort(userId!,phone);
          }catch(err){
           await client.query("ROLLBACK TO SAVEPOINT calling_effect").catch(()=>{});
           effectFeedback+="The call information could not be updated. "+safeVoice(String((err as {message?:unknown})?.message||""),120)+" ";
           sessionId=-1;
          }
         }
        }
        if(sessionId>0){
         const picked=await resolveCaseSelection(client,userId!,report.casePos);
         const purpose=pickedToPurpose(picked);
         const draft=sessionFillFromReport(report);
         draft.purpose=purpose;
         const contact=await findCallingContact(client,userId!,report.phone);
         if(contact)draft.contactName=contact.name;
         else if(report.phone)draft.contactName=report.phone;
         // AUTO-CONTACT: the edited call's number becomes a contact.
         if(report.phone)await autoContactBestEffort(userId!,report.phone);
         let done=false,held=false;
         try{
          if(picked&&picked.kind==="case")await upsertCallReport(client,userId!,sessionId,picked.id,draft);
          else await upsertCallReport(client,userId!,sessionId,null,draft);
          done=true;
         }catch(err){
          await client.query("ROLLBACK TO SAVEPOINT calling_effect").catch(()=>{});
          // No case could be resolved (0 or 2+ open cases, no session
          // case): carry the pick on the session, then hold the
          // fill-in on the session instead.
          if(picked){
           const purposeSafe=purpose??{type:"none",key:null};
           await client.query("UPDATE public.max_call_sessions SET case_id=COALESCE($1,case_id),purpose_type=COALESCE($4,purpose_type),purpose_key=COALESCE($5,purpose_key),updated_at=now() WHERE id=$2 AND user_id=$3",
            [picked.kind==="case"?picked.id:null,sessionId,userId!,purposeSafe.type,purposeSafe.key]).catch(()=>{});
          }
          try{held=await updateSessionFill(client,sessionId,userId!,draft);}catch{held=false;}
         }
         if(done){
          effectFeedback=(await callingVoicePrompt(client,"1592t"))||machineFeedback;
         }else if(held){
          effectFeedback="Call information saved on the call. No case was chosen yet. You can add one later from option 3. ";
         }else effectFeedback="The call information could not be updated. Please try again later. ";
        }
       }else{
        effectFeedback="This item cannot be edited here. ";
       }
      }else if(eff.type==="deleteLog"){
       const item=items[eff.pos]||null;
       const mapped=item?(item.kind==="session"?"session":item.kind==="missed"?"return_call":item.kind==="report"?"report":null):null;
       if(!item||!mapped){
        effectFeedback="This log entry is no longer available. ";
       }else{
        await deleteLogEntry(client,userId!,mapped,item.id);
        effectFeedback+="Deleted. ";
        const adv=await callingAdvanceAfterRemoval(client,userId!,callingState);
        callingState=adv.state;advanced=true;
        if(adv.empty)effectFeedback+="This list is now empty. ";
       }
      }else if(eff.type==="deleteAllLog"){
       await deleteAllLogEntries(client,userId!);
       callingState={...callingState,mode:"menu",option:0,pos:0,kind:null,id:null};
       advanced=true;
       effectFeedback+="All log entries deleted. ";
      }else if(eff.type==="deleteContact"){
       const item=items[eff.pos]||null;
       if(!item||item.kind!=="contact"){
        effectFeedback="This contact is no longer available. ";
       }else{
        await deleteContact(client,userId!,item.id);
        effectFeedback+="Deleted. ";
        const adv=await callingAdvanceAfterRemoval(client,userId!,callingState);
        callingState=adv.state;advanced=true;
        if(adv.empty)effectFeedback+="Your contact list is now empty. ";
       }
      }else if(eff.type==="toggleDNC"){
       const item=items[eff.pos]||null;
       if(!item||item.kind!=="contact"){
        effectFeedback="This contact is no longer available. ";
       }else{
        const row=(await client.query<{do_not_call:boolean}>(
         "SELECT do_not_call FROM public.communication_contacts WHERE id=$1 AND user_id=$2",[item.id,userId!])).rows[0];
        if(!row)effectFeedback="This contact is no longer available. ";
        else{
         await setContactDNC(client,userId!,item.id,!row.do_not_call);
         effectFeedback+=machineFeedback;
        }
       }
      }else if(eff.type==="saveContactNote"){
       const item=items[eff.pos]||null;
       if(!item||item.kind!=="contact"){
        effectFeedback="This contact is no longer available. ";
       }else{
        // The machine already moved to the contact menu; the engine
        // records the voice note on the next ("rr") turn.
        callingPending={kind:"contact-note",pos:eff.pos,field:eff.field,contactId:item.id};
       }
      }else if(eff.type==="recordNote"){
       callingPending={kind:"fill-note"};
      }else if(eff.type==="savePickupAddress"){
       // The pickup address is recorded as a voice note on the next
       // ("rr") turn and attached to the contact. The contact is
       // resolved from the call's phone (auto-contact already created
       // it from the dial/log); if there is no contact yet, the
       // address cannot be attached — the caller hears so honestly.
       const contact=await findCallingContact(client,userId!,callingState.phone??null);
       const contactId=contact?contact.id:await autoContactBestEffort(userId!,callingState.phone??null);
       if(contactId===null){
        effectFeedback+="There is no contact to save the address with. ";
        if(callingState)callingState=advanceAfterPickupAddress(callingState);
       }else{
        callingPending={kind:"pickup-address",contactId};
       }
      }else if(eff.type==="schedule"){
       // Scheduling is NEVER auto-dial: the row only ever becomes a
       // Tishl reminder. insertScheduledCall also writes the
       // tishl_reminders row; it FAILS until the calling migration is
       // applied (missing table + item_kind CHECK) — its own savepoint
       // keeps the failure from aborting this call, and the caller
       // hears the failure honestly instead of a confirmation.
       try{
        await client.query("SAVEPOINT calling_schedule");
        try{
         let contactId:number|null=null,displayName="",phone=eff.phone;
         if(eff.contactPos!==null&&eff.contactPos!==undefined){
          const contacts=await getCallingContacts(client,userId!,0);
          const c=contacts[eff.contactPos]||null;
          if(c){contactId=c.id;displayName=c.name;phone=c.phone;}
         }
         // Pickup flow (and any schedule without a contact position):
         // resolve the contact from the phone number (auto-contact has
         // already created it from the dial/log), so the scheduled
         // pickup carries the contact and the address note lands right.
         if(contactId===null&&phone){
          const found=await findCallingContact(client,userId!,phone);
          if(found){contactId=found.id;displayName=found.name;}
         }
         if(!phone){
          throw new Error("No phone number for this scheduled call");
         }
         const picked=await resolveCaseSelection(client,userId!,eff.casePos);
         await insertScheduledCall(client,userId!,{contactId,numberE164:phone,
          displayName:displayName||undefined,scheduledAt:eff.at,
          caseId:picked&&picked.kind==="case"?picked.id:null,
          campaignId:picked&&picked.kind==="campaign"?picked.id:null,
          projectId:picked&&picked.kind==="project"?picked.id:null,
          note:eff.note??undefined});
         await client.query("RELEASE SAVEPOINT calling_schedule");
        }catch(inner){
         await client.query("ROLLBACK TO SAVEPOINT calling_schedule").catch(()=>{});
         throw inner;
        }
       }catch(err){
        // The machine already spoke the scheduled date; correct it.
        effectFeedback="The scheduled call could not be saved. "+safeVoice(String((err as {message?:unknown})?.message||""),120)+" ";
       }
      }else if(eff.type==="markDone"){
       const item=items[eff.pos]||null;
       if(!item||item.kind!=="missed"){
        effectFeedback="This item is not a missed call. ";
       }else{
        // Completed on max_return_calls (and hidden from Tishl too).
        await markTishlDone(client,userId!,"missed_call",item.id);
        effectFeedback+="Marked done. ";
        const adv=await callingAdvanceAfterRemoval(client,userId!,callingState);
        callingState=adv.state;advanced=true;
        if(adv.empty)effectFeedback+="You have no more missed calls. ";
       }
      }
     }catch(err){
      await client.query("ROLLBACK TO SAVEPOINT calling_effect").catch(()=>{});
      effectFeedback="That could not be saved. "+safeVoice(String((err as {message?:unknown})?.message||""),120)+" ";
     }
     await client.query("RELEASE SAVEPOINT calling_effect").catch(()=>{});
     feedback+=effectFeedback;
     // A fill session ends when the caller is back at the top menu.
     if(callingState&&callingState.mode==="menu"&&callingState.option===0)callingSessionId=null;
     // Re-sync kind/id for list modes from the current list (the edit
     // flow resets pos, so after updateReport this points at item 0).
     if(callingState&&!advanced&&["list","detail","contact-menu","confirm-delete","confirm-delete-all"].includes(callingState.mode)){
      const fresh=await loadCallingList(client,userId!,callingState);
      const cur=fresh.items[callingState.pos]||null;
      callingState.kind=cur?cur.kind:null;callingState.id=cur?cur.id:null;
     }
    }
   }else if(path==="1593"){
    // Categories. Same linked-member + Olam-access gate as 1591/1592;
    // on SignalWire the digit gate is bypassed via treeSelect, so the
    // gate is checked here again. No dialling anywhere in this path.
    const verified=!!userId&&await memberAllowed(client,{...s,member_id:userId});
    const accessRow=verified?(await client.query<{status:string}>(
     "SELECT status FROM public.gavhah_olam_chesed_access WHERE user_id=$1",[userId])).rows[0]:null;
    if(!verified||accessRow?.status!=="linked"){
     path="159";categoriesState=null;
     feedback="Your Olam Chesed access is not linked. ";
    }else{
     if(!categoriesState)categoriesState=newCategoriesState();
     const {values,contacts}=await loadCategoriesList(client,userId!,categoriesState);
     const listLength=categoriesState.mode==="values"?values.length
      :categoriesState.mode==="list"?contacts.length:0;
     const result=handleCategoriesDigit(categoriesState,digit,listLength);
     categoriesState=result.state;
     feedback+=result.feedback;
     if(result.effect.type==="leave"){
      path="159";categoriesState=null;
     }
    }
   }else if(path==="" && !from4444){
    // TRUE 16-department root (live v117). The campaign4444 fork is gone:
    // this menu is served regardless of campaign state, on Yemot and on
    // SignalWire (one engine). Gated departments send logged-out callers
    // to the login gate (path 120) with the target in action_flash.
    // 4444 -> go_to_folder=/4444 (gated, live); 64 -> go_to_folder=/64
    // (ungated — live never tested whether 64 is gated); 0 -> 185
    // registration (live v117 0 is registration, not provider management).
    const target=rootTargetForDigit(digit);
    position=0;chunk=0;page=0;confirmId=null;
    if(!target){
     feedback="That option is not available. ";
    }else if(target.kind==="folder4444"){
     if(!!userId&&await memberAllowed(client,s))goToCampaignExtension=true;
     else{path=GATE_PATH;manualFlash=encodeGateFlash({target:GATE_TARGET_4444});}
    }else if(target.kind==="folder64"){
     goToFolder64=true;
    }else if(target.kind==="register"){
     path="185";feedback="You chose Gavhah website member signup. ";
    }else if(target.gated&&!(!!userId&&await memberAllowed(client,s))){
     path=GATE_PATH;manualFlash=encodeGateFlash({target:target.path});
    }else{
     path=target.path;
    }
   }else if(replyMode){
    if(!await memberAllowed(client,{...s,member_id:userId})){
      replyMode=false;actionsOpen=false;feedback="Phone login expired. Please pair your account on the website. ";
    }else if(replyTarget===0||replyTarget===-1){
     // A NEW update inserted from the phone (0 = own voice, -1 = system
     // voice). Not a reply to an article: save as a phone submission for
     // moderation. System voice (option 2) is UPDATES ONLY.
     const result=await savePhoneNewsSubmission(client,replyTarget===-1?"system_voice":"own_voice",userId!,callHash,digit);
     replyMode=false;replyTarget=null;actionsOpen=false;feedback=result.info+" ";
    }else if(replyTarget===-2){
     // A NEW discussion opened from the phone (own voice recording only;
     // no text, no system voice — Yakob 2026-11-20 04:54 rule 4).
     const result=await saveDiscussionVoiceOpening(client,userId!,callHash,digit);
     replyMode=false;replyTarget=null;actionsOpen=false;feedback=result.info+" ";
    }else{
      const result=await saveVoiceNewsReply(client,replyTarget||0,userId!,callHash,digit);
      replyMode=false;actionsOpen=true;feedback=result.info+" ";
    }
   }else if(reportMode){
    if(digit==="0"){path="";actionsOpen=false;reportMode=false;}
    else if(digit==="9"){reportMode=false;actionsOpen=!(path==="116"||path==="97020");}
    else{
     if(!await memberAllowed(client,{...s,member_id:userId})){feedback="Please link your account first. ";}
     else if(replyTarget){feedback=(await phoneNewsReport(client,userId!,replyTarget,digit,path==="97020"?"discussion":"news"))+" ";}
     reportMode=false;
     // From an insert menu (116/97020) stay there after reporting;
     // from an article actions menu return to the actions menu.
     actionsOpen=!(path==="116"||path==="97020");
    }
   }else if(actionsOpen){
    const articleId=await currentNewsId(path,position,confirmId);
    if(digit==="0"){path="";position=0;chunk=0;confirmId=null;actionsOpen=false;replyMode=false;replyTarget=null;}
    else if(digit==="9"){actionsOpen=false;}
    else if(digit==="1"||digit==="2"){
     if(!articleId){feedback="News update not found. ";}
     else if(!await memberAllowed(client,{...s,member_id:userId})){
       feedback="Please link your account with an eight digit code in My Askanus before voting. ";
     }else{
       const response=await phoneNewsVote(client,userId!,articleId,digit==="1");
       feedback=response.info+" ";
     }
    }else if(digit==="3"){
     if(!articleId){feedback="News update not found. ";}
     else if(!await memberAllowed(client,{...s,member_id:userId})){
       feedback="Please link your account before recording a reply. ";
     }else{
       replyMode=true;replyTarget=articleId;actionsOpen=false;
       feedback="Your recording will be submitted for review and published on the same website article only after approval. ";
     }
    }else if(digit==="5"||digit==="6"){
     if(!articleId){feedback="News update not found. ";}
     else if(!await memberAllowed(client,{...s,member_id:userId})){
      feedback="Please link your account before saving an update. ";
     }else{feedback=(await phoneNewsSave(client,userId!,articleId,digit==="5"))+" ";}
    }else if(digit==="7"){
     if(!articleId){feedback="News update not found. ";}
     else if(!await memberAllowed(client,{...s,member_id:userId})){
      feedback="Please link your account before reporting an update. ";
     }else{replyTarget=articleId;reportMode=true;actionsOpen=false;}
    }else if(digit==="4"){
     if(!articleId){feedback="News update not found. ";}
     else{
      const r=await client.query("SELECT like_count FROM public.news WHERE id=$1",[articleId]);
      feedback="Current upvote count is "+Number(r.rows[0]?.like_count||0)+". ";
     }
    }
   }else if(path==="185"){
    // Public Gavhah registration, not Neon Auth Campaign Center membership.
    // Caller ID is not accepted as identity. PIN is hashed and confirmed twice.
    if(digit==="0"){
      await cancelPhoneSignup(client,callHash);path="";feedback="";
    }else if(userId && await memberAllowed(client,{...s,member_id:userId})){
      path="18";feedback="You already have a signed in website account on this call. ";
    }else{
      const result=await enrollFromKeypad(client,callHash,digit);
      feedback=result.message;
      if(result.completed && result.userId){
        userId=result.userId;s.member_id=userId;
        s.linked_until=new Date(Date.now()+30*60*1000).toISOString();
        path="18";
      }
    }
   }else if(path==="125"){
    if(digit==="0"){path="";}
    else if(digit==="123456"&&s.login_failures<5&&
      process.env.GAVHAH_PHONE_TEST_PIN_ENABLED==="true"){
     // Explicit, revocable 24-hour *non-admin*, no-personal-data test account.
     // Both independent Yemot and SignalWire use the SAME verified menu engine.
     const accountId=Number(process.env.GAVHAH_PHONE_TEST_MEMBER_ID||0);
     const until=Date.parse(process.env.GAVHAH_PHONE_TEST_PIN_EXPIRES_AT||"");
     if(Number.isSafeInteger(accountId)&&accountId>0&&Number.isFinite(until)&&
        until>Date.now()&&until-Date.now()<=24*60*60*1000){
      const account=await client.query<{id:number}>(
       "SELECT id FROM public.users WHERE id=$1 AND role='member' AND status='active' "+
       "AND name='Gavhah Temporary Phone Test Member' AND email IS NULL AND phone IS NULL "+
       "AND password_hash='disabled-phone-test-only'",[accountId]);
      if(account.rowCount){
       userId=accountId;s.member_id=accountId;s.login_failures=0;
       s.linked_until=new Date(Math.min(until,Date.now()+10*60*1000)).toISOString();
       path="12";feedback="Test member connected for ten minutes. Super admin access is disabled. ";
      }else{s.login_failures++;feedback="Test member login is not configured. ";}
     }else{s.login_failures++;feedback="The temporary test password has expired. ";}
    }
    else if(/^\d{8}$/.test(digit)&&s.login_failures<5){
     const key=process.env.YEMOT_ENCRYPTION_KEY||"";
     if(key.length>=36){
      const digest=createHmac("sha256",key).update("gavhah-phone-link-v1:"+digit).digest("hex");
      const used=await client.query<{user_id:number}>(
       "UPDATE public.gavhah_phone_pair_codes SET redeemed_at=now() "+
       "WHERE code_hash=$1 AND redeemed_at IS NULL AND expires_at>now() AND user_id IN "+
       "(SELECT id FROM public.users WHERE status NOT IN ('banned','suspended')) RETURNING user_id",[digest]);
      if(used.rows[0]){
       userId=used.rows[0].user_id;
       s.member_id=userId;s.login_failures=0;
       s.linked_until=new Date(Date.now()+30*60*1000).toISOString();
       path="12";feedback="Your account is securely connected for thirty minutes. ";
      }else{
       s.login_failures++;feedback="The code was invalid or expired. ";
      }
     }else{feedback="Secure code verification is not configured. ";}
    }else{
     s.login_failures++;
     feedback="Enter the eight digit website code. ";
    }
   }else if(path==="115"){
    if(digit==="0"){path="";confirmId=null;chunk=0;actionsOpen=false;}
    else if(confirmId===null){
     if(/^\d{1,8}$/.test(digit)&&Number(digit)>0){
      // Gate (rule 1): only an update with a published recording can be
      // heard. A text-only number is refused here, before it is stored.
      if(!await newsHasPublishedAudio(client,Number(digit))){
       feedback="This update has no recording on the phone. Text updates are on the website. ";
      }else{confirmId=Number(digit);chunk=0;}
     }
    }else if(digit==="1"){actionsOpen=true;}
    else if(digit==="8"){chunk=0;}
    else if(digit==="2"||digit===""||digit==="None"){
     const current=await articlePrompt(client,confirmId,chunk);
     // Build B: on Yemot a recorded article is ONE hearing (the whole
     // recording plays at once), so 2 goes to the next article, never to
     // a next text chunk. On SignalWire the text still chunks.
     const more=current.hasMore&&!(current.audio&&!fromShared);
     if(more)chunk++;
     else{confirmId=null;chunk=0;feedback="End of article. Enter another article number. ";}
    }
   }else if(path==="116"){
    // News insert menu (Yakob 2026-11-20 04:46). 1 = own voice, 2 =
    // system voice (record -> STT Yiddish transcript -> pinchas TTS via
    // Yiddish Tools; the re-voiced audio is stored on the submission and
    // the update is created when an admin approves it), 3 = report this
    // update. Star / pound = back to the updates list (the path stored in
    // action_flash when 0 was pressed there). 0 = main menu.
    const backTo=readReturnPath(manualFlash,"newsFrom")||newsAll;
    if(digit==="0"){path="";position=0;chunk=0;page=0;confirmId=null;manualFlash="";}
    else if(digit==="*"||digit==="#"){path=backTo;position=0;chunk=0;page=0;confirmId=null;manualFlash="";}
    else if(digit==="1"||digit==="2"){
     if(!await memberAllowed(client,{...s,member_id:userId})){
      feedback="Please link your account first. ";
     }else{
      replyMode=true;replyTarget=digit==="1"?0:-1;actionsOpen=false;
      feedback=digit==="1"
       ?"Record your update with your own voice after the beep. "
       :"Record your update after the beep. The system will voice it in its own voice after review. ";
     }
    }
    else if(digit==="3"){
     if(!confirmId){feedback="There is no update to report right now. ";}
     else if(!await memberAllowed(client,{...s,member_id:userId})){
      feedback="Please link your account first. ";
     }else{
      reportMode=true;replyTarget=confirmId;actionsOpen=false;
      feedback="Choose a report reason for this update. ";
     }
    }
   }else if(publicIdSections.has(path)){
    // Type a website ID using up to eight digits. Once a public record is
    // selected, one, eight and two navigate paragraphs; nine picks another.
    if(digit==="0"){path="";confirmId=null;page=0;}
    else if(confirmId===null){
     if(/^\d{1,8}$/.test(digit)&&Number(digit)>0){
      confirmId=Number(digit);page=0;
     }else feedback="Enter the website item number, one to eight digits, then press pound. ";
    }else if(digit==="9"){confirmId=null;page=0;}
    else if(digit==="1")page=Math.min(34,page+1);
    else if(digit==="8")page=Math.max(0,page-1);
    else if(digit==="2")page=0;
    else feedback="Press one for next, eight for previous, two to restart, nine for another item, or zero for the main menu. ";
   }else if(newsPath(path)){
    // Updates list (Yakob 2026-11-20 04:46): 1 = hear an update by its
    // number (path 115), 2 = next, 3 = important and critical, 4 = all,
    // 5 = this update options (the actions menu moved here because 1 is
    // now select-by-number), 8 = previous, star = quick insert with your
    // own voice, pound / 9 = back to the News menu, 0 = insert menu.
    // Pound is BACK here by his explicit spec — in Tishl star is back
    // and pound is next, but here he said pound = go back. Do not import
    // the Tishl keys.
    if(digit==="0"){const from=path;path="116";position=0;chunk=0;page=0;actionsOpen=false;confirmId=await currentNewsId(from,position,null);manualFlash=JSON.stringify({newsFrom:from});}
    else if(digit==="1"){path="115";position=0;chunk=0;page=0;confirmId=null;actionsOpen=false;}
    else if(digit==="5"){actionsOpen=true;}
    else if(digit==="3"){path=newsImportant;position=0;chunk=0;}
    else if(digit==="4"){path=newsAll;position=0;chunk=0;}
    else if(digit==="8"){position=Math.max(0,position-1);chunk=0;}
    else if(digit==="*"){
     if(!await memberAllowed(client,{...s,member_id:userId})){
      feedback="Please link your account first. ";
     }else{
      replyMode=true;replyTarget=0;actionsOpen=false;
      feedback="Record your update after the beep. ";
     }
    }
    else if(digit==="#"||digit==="9"){path="11";position=0;chunk=0;page=0;actionsOpen=false;}
    else if(digit==="2"||digit===""||digit==="None"){
     const now=await newsPrompt(path,position,chunk);
     // Build B: on Yemot a recorded update is ONE hearing — 2 goes to the
     // next update, never to a next text chunk. SignalWire still chunks.
     const more=now.hasMore&&!(now.audio&&!fromShared);
     if(more)chunk++;else{position++;chunk=0;}
    }
   }else if(path==="97021"){
    // Discussions list (Askanim talk) — the same keys as the News list,
    // but there is no actions menu for discussions. 1 = by number,
    // 2 = next, 8 = previous, star = quick insert (own voice recording),
    // pound / 9 = back to the Askanim menu, 0 = insert menu.
    if(digit==="0"){path="97020";position=0;chunk=0;page=0;actionsOpen=false;confirmId=await currentDiscussionId(position);manualFlash=JSON.stringify({discFrom:"97021"});}
    else if(digit==="1"){path="97022";position=0;chunk=0;page=0;confirmId=null;}
    else if(digit==="8"){position=Math.max(0,position-1);chunk=0;}
    else if(digit==="*"){
     if(!await memberAllowed(client,{...s,member_id:userId})){
      feedback="Please link your account first. ";
     }else{
      replyMode=true;replyTarget=-2;actionsOpen=false;
      feedback="Record your discussion after the beep. ";
     }
    }
    else if(digit==="#"||digit==="9"){path="9702";position=0;chunk=0;page=0;}
    else if(digit==="2"||digit===""||digit==="None"){
     const now=await discussionPrompt(position,chunk);
     // Build B: on Yemot a recorded discussion is ONE hearing — 2 goes to
     // the next discussion, never to a next text chunk. SignalWire chunks.
     const more=now.hasMore&&!(now.audio&&!fromShared);
     if(more)chunk++;else{position++;chunk=0;}
    }
   }else if(path==="97022"){
    // Hear a discussion by its number (recorded discussions only).
    if(digit==="0"){path="";confirmId=null;chunk=0;}
    else if(digit==="#"){path="97021";confirmId=null;chunk=0;position=0;}
    else if(confirmId===null){
     if(/^\d{1,8}$/.test(digit)&&Number(digit)>0){
      // Gate (rule 1): only a discussion with a published recording can
      // be heard. A text-only number is refused here, before it is stored.
      if(!await discussionHasPublishedAudio(client,Number(digit))){
       feedback="This discussion has no recording on the phone. Text discussions are on the website. ";
      }else{confirmId=Number(digit);chunk=0;}
     }
    }
    else if(digit==="8"){chunk=0;}
    else if(digit==="9"){confirmId=null;chunk=0;}
    else if(digit==="2"||digit===""||digit==="None"){
     const current=await discussionByIdPrompt(client,confirmId,chunk);
     // Build B: on Yemot a recorded discussion is ONE hearing — 2 goes to
     // the next discussion, never to a next text chunk. SignalWire chunks.
     const more=current.hasMore&&!(current.audio&&!fromShared);
     if(more)chunk++;
     else{confirmId=null;chunk=0;feedback="End of discussion. Enter another discussion number. ";}
    }
   }else if(path==="97020"){
    // Discussions insert menu (Yakob 2026-11-20 04:54 rule 4): recordings
    // ONLY. No text, NO system-voice option (that is updates only).
    // 1 = open a new discussion with your own voice (recording).
    // 3 = report a discussion. Star / pound = back to the discussions
    // list. 0 = main menu.
    const backTo=readReturnPath(manualFlash,"discFrom")||"97021";
    if(digit==="0"){path="";position=0;chunk=0;page=0;confirmId=null;manualFlash="";}
    else if(digit==="*"||digit==="#"){path=backTo;position=0;chunk=0;page=0;confirmId=null;manualFlash="";}
    else if(digit==="1"){
     if(!await memberAllowed(client,{...s,member_id:userId})){
      feedback="Please link your account first. ";
     }else{
      replyMode=true;replyTarget=-2;actionsOpen=false;
      feedback="Record your discussion after the beep. ";
     }
    }
    else if(digit==="3"){
     if(!confirmId){feedback="There is no discussion to report right now. ";}
     else if(!await memberAllowed(client,{...s,member_id:userId})){
      feedback="Please link your account first. ";
     }else{
      reportMode=true;replyTarget=confirmId;actionsOpen=false;
      feedback="Choose a report reason for this discussion. ";
     }
    }
   }else if(path==="9702"&&(digit==="*"||digit==="#")){
    // The Askanim first screen says "Press star to return": star (and
    // pound) go back to the main menu. Without this, treeSelect would
    // leave the caller on 9702 (a no-op).
    path="";position=0;chunk=0;page=0;confirmId=null;
   }else if(path==="141" && (digit==="9"||readManualResultPending(manualFlash))){
    if(!userId||!await memberAllowed(client,{...s,member_id:userId})){
      manualFlash="";
      feedback="Please link your own Gavhah website account with the eight digit code first. ";
    }else{
      const existing=readManualResultPending(manualFlash);
      if(digit==="0"){manualFlash="";path="";page=0;feedback="Cancelled. No call result was recorded. ";}
      else if(existing && existing.userId===userId){
        if(existing.stage==="choose"){
          const outcome=manualOutcomes[digit];
          if(!outcome)feedback=choosePrompt+" ";
          else{
            existing.outcome=outcome;existing.stage="confirm";
            manualFlash=JSON.stringify(existing);
            feedback=confirmationPrompt(existing)+" ";
          }
        }else if(digit==="5"){
          feedback=(await recordConfirmedManualResult(client,existing))+" ";
          manualFlash="";
        }else feedback=confirmationPrompt(existing)+" ";
      }else if(digit==="9"){
        const picked=await client.query<{id:number;name:string}>(
          "SELECT id,name FROM public.communication_contacts "+
          "WHERE user_id=$1 AND do_not_call=false ORDER BY updated_at DESC,id DESC LIMIT 1 OFFSET $2",
          [userId,Math.max(0,Math.min(40,page))]);
        // Never silently attribute a call to an unrelated case. Until the
        // keypad supports explicit case selection, require exactly one open case.
        const matchingCase=await client.query<{id:number}>(
          "SELECT id FROM public.askanus_cases WHERE user_id=$1 AND status!='closed' "+
          "ORDER BY last_updated DESC,id DESC LIMIT 2",[userId]);
        if(!picked.rows[0])feedback="This calling-list contact is unavailable. Nothing was recorded. ";
        else if(!matchingCase.rows[0])feedback="Please create an open MAX case on your website before recording a call result. ";
        else if(matchingCase.rows.length>1)feedback="You have more than one open MAX case. To prevent incorrect case attribution, choose the case and log this result on the website. ";
        else{
          const contact=picked.rows[0];
          manualFlash=JSON.stringify({
            stage:"choose",userId,contactId:contact.id,caseId:matchingCase.rows[0].id,
            contactName:contact.name.slice(0,240),expiresAt:Date.now()+5*60*1000,
            requestId:createHash("sha256").update(callHash+":"+step+":"+contact.id).digest("hex")
          } satisfies ManualResultPending);
          feedback=choosePrompt+" ";
        }
      }else{manualFlash="";feedback="The previous result session has expired. Press nine to start again. ";}
    }
   }else if(sectionPaths.has(path)){
    // For protected actions require a recently paired website identity.
    // Every row is further scoped to that member ID in the SQL.
    if(digit==="0"){path="";page=0;confirmId=null;}
    else if(digit==="5" && (path==="132"||path==="181")){
      if(!userId || !await memberAllowed(client,{...s,member_id:userId})){
        feedback="Link your Gavhah account using the website code before changing private records. ";
        confirmId=null;
      }else{
        const id=await currentPhoneActionId(client,path,userId,page);
        if(!id){feedback="This record is not available. ";confirmId=null;}
        else if(confirmId===id){
          feedback=(await confirmPhoneAction(client,path,userId,id))+" ";
          confirmId=null;
        }else{
          confirmId=id;
          feedback=path==="132"
           ?"Press 5 again to confirm Do Not Call for this contact. "
           :"Press 5 again to mark this notification as read. ";
        }
      }
    }
    else if(pagedSections.has(path)&&digit==="1"){page=Math.min(40,page+1);confirmId=null;}
    else if(pagedSections.has(path)&&digit==="8"){page=Math.max(0,page-1);confirmId=null;}
    else if(pagedSections.has(path)&&digit==="2"){page=0;confirmId=null;}
    else confirmId=null;
   }else if(personalPaths.has(path)){
    if(digit==="0"){path="";page=0;confirmId=null;}
    else if(digit==="1"){page++;confirmId=null;}
    else if(digit==="8"){page=Math.max(0,page-1);confirmId=null;}
    else if(digit==="2"){page=0;confirmId=null;}
    else if(digit==="5"&&path==="121"&&userId&&await memberAllowed(client,s)){
     const current=await client.query<{id:number;completed:boolean}>(
       "SELECT id,completed FROM public.askanus_tasks WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET $2",[userId,page]);
     const item=current.rows[0];
     if(item&&!item.completed){
      if(confirmId===item.id){
       await client.query("UPDATE public.askanus_tasks SET completed=true,completed_at=now() "+
        "WHERE id=$1 AND user_id=$2 AND completed=false",[item.id,userId]);
       confirmId=null;feedback="Task marked complete on your website account. ";
      }else{confirmId=item.id;feedback="Please press 5 again to confirm. ";}
     }
    }
   }else if(path==="126"){
    // A sign-out action is deliberately reachable only through My Askanus.
    userId=null;s.member_id=null;s.linked_until=null;path="12";feedback="You have signed out from this call. ";
   }else if(path==="9708"&&["1","2","3","4"].includes(digit)){
    // Groups menu (copy's real groups sections; live v117 returns a stub
    // for 8, but the sections are built — see true-menu.ts).
    path={"1":"161","2":"162","3":"163","4":"164"}[digit]!;
    position=0;chunk=0;page=0;confirmId=null;
   }else if(path==="97193"&&["1","2","3"].includes(digit)){
    // My Connections (live 13): 1 connections list, 2 volunteer
    // application, 3 help from Askanim -> closest existing sections.
    path={"1":"164","2":"153","3":"152"}[digit]!;
    position=0;chunk=0;page=0;confirmId=null;
   }else if(path==="9703"&&digit==="9"){
    // Private help (live 3): 9 = private Gavhah connections.
    path="132";position=0;chunk=0;page=0;confirmId=null;
   }else{
    path=treeSelect(path,digit,tree);
    if(path==="126"){
      userId=null;s.member_id=null;s.linked_until=null;path="12";feedback="You have signed out from this call. ";
    }
    position=0;chunk=0;page=0;confirmId=null;
   }
   step++;
  }
  let mode:"menu"|"root"|"news"|"code"|"article"|"record"|"registration"="menu",spoken=feedback;
  if(reportMode){
   spoken+="Choose a report reason. Press 1 spam, 2 inappropriate, 3 misinformation, 4 harassment, or 5 other. Press 9 to cancel or zero for the main menu.";
  }else if(replyMode){
   mode="record";
   // replyTarget 0 = a new update (own voice), -1 = a new update
   // (system voice), -2 = a new discussion (own voice recording only);
   // any other value is a reply to an existing article.
   if(replyTarget===0)spoken+="Record your update with your own voice after the beep and press pound when finished. You may cancel by hanging up.";
   else if(replyTarget===-1)spoken+="Record your update after the beep and press pound when finished. The system will voice it in its own voice after review. You may cancel by hanging up.";
   else if(replyTarget===-2)spoken+="Record your discussion with your own voice after the beep and press pound when finished. You may cancel by hanging up.";
   else spoken+="Record your reply after the beep and press pound when finished. You may cancel by hanging up.";
  }else if(actionsOpen){
   const articleId=await currentNewsId(path,position,confirmId);
   spoken+=await actionsMenu(client,articleId,userId,await memberAllowed(client,{...s,member_id:userId}));
  }else if(path==="1591"){
   // Tishl. The gate is checked again here (defense in depth): on SignalWire
   // the digit gate is bypassed via treeSelect, so this branch re-checks the link.
   const verified=!!userId&&await memberAllowed(client,{...s,member_id:userId});
   const accessRow=verified?(await client.query<{status:string}>(
    "SELECT status FROM public.gavhah_olam_chesed_access WHERE user_id=$1",[userId])).rows[0]:null;
   if(!verified||accessRow?.status!=="linked"){
    path="159";tishlState=null;page=0;confirmId=null;
    spoken=!verified
     ?"Olam Chesed Communication is a separate SignalWire service. To apply, securely link your Gavhah account under My Askanus option 2 then 5, or fill the website access request form. Press zero to go back."
     :"Your Olam Chesed request is "+(accessRow?.status==="requested"?"awaiting administration":accessRow?.status==="reviewing"?"under review":"not approved")+". Press 1 to send an access request to administration. Press zero to go back.";
   }else{
    if(!tishlState)tishlState=newTishlState();
    const queue=await getTishlQueue(client,userId!);
    if(tishlState.pos>queue.length)tishlState.pos=queue.length;
    const item=queue[tishlState.pos]||null;
    page=tishlState.pos;
    confirmId=item?item.id:null;
    const nowParts=tzParts(new Date(),TISHL_TZ);
    const todayHebrew=hebrewFromGregorian(nowParts.year,nowParts.month,nowParts.day);
    if(!queue.length){
     path="159";tishlState=null;page=0;confirmId=null;
     spoken+=await voicePrompt("1591f","You have no items on your Tishl. ");
    }else if(tishlState.mode==="date-choice"){
     mode="menu";
     const parsha=parshaForGregorianDate(nowParts.year,nowParts.month,nowParts.day);
     // 1591d stays TEXT-only on purpose: this turn also speaks the date
     // and the live Parsha ("This week's Parsha is Vayetzei"), which a
     // static recording would hide. The 1591d draft is a spare.
     const choice=await tishlVoicePrompt(client,"1591d");
     spoken+="Today is "+formatHebrewDate(todayHebrew)+"."+(parsha?" This week's Parsha is "+parsha+".":"")+" "+(choice||"Press 1 for a Jewish date, 2 for numbers.");
    }else if(tishlState.mode==="date-day"||tishlState.mode==="date-month"||tishlState.mode==="date-hour"||tishlState.mode==="date-minute"){
     mode="article";
     if(tishlState.mode==="date-day")spoken+=tishlState.dateKind==="jewish"
      ?"Enter the day of the Jewish month, 1 to 30, then press pound. Press star to go back."
      :"Enter the day of the month, 1 to 31, then press pound. Press star to go back.";
     else if(tishlState.mode==="date-month"){
      if(tishlState.dateKind==="jewish"){
       // Offer Adar II too when the next Hebrew year is a leap year.
       const nextLeap=!isHebrewLeapYear(todayHebrew.year)&&isHebrewLeapYear(todayHebrew.year+1);
       spoken+=hebrewMonthChoicesSpeech(todayHebrew.year,nextLeap)+" Enter the month number, then press pound. Press star to go back.";
      }else spoken+="Enter the month as a number, 1 for January through 12 for December, then press pound. Press star to go back.";
     }
     else if(tishlState.mode==="date-hour")spoken+="Enter the hour, 0 to 23, then press pound. Press star to go back.";
     else spoken+="Enter the minute, 0 to 59, then press pound. Press star to go back.";
    }else if(tishlState.mode==="note"){
     mode="record";
     // No draft row exists for the record prompt itself; the built-in text
     // is the prompt. The "note saved" confirmation (1591e) is spoken after.
     spoken+="Record your voice note after the beep and press pound when finished. You may cancel by hanging up.";
    }else if(tishlState.mode==="action"){
     mode="menu";
     // 1591a/1591b stay TEXT-only on purpose: the action menu is TWO
     // recordings (parts 1+2), and one turn can play only one audio
     // file — playing part 1 would hide part 2. The drafts are spares.
     const menuA=await tishlVoicePrompt(client,"1591a");
     const menuB=await tishlVoicePrompt(client,"1591b");
     const menuText=(menuA||menuB)?[menuA,menuB].filter(Boolean).join(" "):null;
     spoken+=menuText||actionMenuSpeech(item);
    }else if(tishlState.mode==="confirm-delete"){
     mode="menu";
     spoken+=await voicePrompt("1591w","Press 3 again to delete this item, or any other key to cancel.");
    }else{
     mode="menu";
     if(tishlState.pos>=queue.length){
      spoken+=await voicePrompt("1591v","You have reached the end of your Tishl. Press pound to hear them again from the start, or press star to go back.");
     }else if(tishlState.fullRead&&item){
      const chunks=splitSpeechChunks(item.detail,215);
      const part=Math.min(tishlState.chunk||0,chunks.length-1);
      spoken+=(chunks[part]||"This message has no text.")+". Press 2 for the next part, or 9 to return to the list.";
     }else if(item){
      const extra=await tishlItemExtra(client,item);
      spoken+=describeTishlItem(item,tishlState.pos,queue.length,extra);
     }
    }
   }
  }else if(path==="1592"){
   // Calling. Same gate as the 1591 render (defense in depth): on
   // SignalWire the digit gate is bypassed via treeSelect, so this
   // branch re-checks the link.
   const verified=!!userId&&await memberAllowed(client,{...s,member_id:userId});
   const accessRow=verified?(await client.query<{status:string}>(
    "SELECT status FROM public.gavhah_olam_chesed_access WHERE user_id=$1",[userId])).rows[0]:null;
   if(!verified||accessRow?.status!=="linked"){
    path="159";callingState=null;callingSessionId=null;callingPending=null;page=0;confirmId=null;
    spoken=!verified
     ?"Olam Chesed Communication is a separate SignalWire service. To apply, securely link your Gavhah account under My Askanus option 2 then 5, or fill the website access request form. Press zero to go back."
     :"Your Olam Chesed request is "+(accessRow?.status==="requested"?"awaiting administration":accessRow?.status==="reviewing"?"under review":"not approved")+". Press 1 to send an access request to administration. Press zero to go back.";
   }else{
    if(!callingState)callingState=newCallingState();
    const provider=fromShared?"signalwire":"yemot";
    const {items,cases}=await loadCallingList(client,userId!,callingState);
    const item=callingState.mode==="select-case"?null:items[callingState.pos]||null;
    if(callingState.mode!=="select-case"&&callingState.pos>items.length)callingState.pos=items.length;
    page=callingState.pos;
    confirmId=item?item.id:null;
    if(callingPending){
     // A voice note is being recorded now ("rr" input).
     mode="record";
     spoken+="Record your voice note after the beep and press pound when finished. You may cancel by hanging up.";
    }else if(callingState.mode==="menu"){
     mode="menu";
     spoken+=await voicePrompt("1592",callingMenuSpeech(provider));
    }else if(callingState.mode==="filter"){
     mode="menu";
     spoken+=await voicePrompt("1592a",filterMenuSpeech());
    }else if(callingState.mode==="list"){
     mode="menu";
     if(!items.length){
      callingState={...callingState,mode:"menu",option:0,pos:0,kind:null,id:null};
      spoken+=await voicePrompt("1592q","This list is empty. ");
     }else if(callingState.pos>=items.length){
      spoken+=await voicePrompt("1592r","You have reached the end of the list. Press pound to hear them again, or star to go back.");
     }else if(item){
      spoken+=describeCallingItem(item,callingState.pos,items.length);
     }
    }else if(callingState.mode==="detail"){
     mode="menu";
     const key=callingState.option===4?"1592c":"1592b";
     spoken+=await voicePrompt(key,detailMenuSpeech(callingState.option,item,provider));
    }else if(callingState.mode==="contact-menu"){
     mode="menu";
     spoken+=await voicePrompt("1592d",contactMenuSpeech(item));
    }else if(callingState.mode==="edit-field"){
     mode="menu";
     spoken+=await voicePrompt("1592e",editFieldSpeech());
    }else if(callingState.mode==="edit-value"){
     mode="menu";
     spoken+=await voicePrompt("1592f",editValueSpeech(callingState.editField||"note"));
    }else if(callingState.mode==="select-case"){
     mode="menu";
     if(!cases.length){
      spoken+="No case, campaign, or project is on your account. Press pound to continue without one. Press star to go back.";
     }else{
      const at=Math.min(callingState.pos,cases.length-1);
      const picked=cases[at];
      // 1592g stays TEXT-only on purpose: this turn also speaks the
      // picked case/campaign/project title, which a static recording
      // would hide. The 1592g draft is a spare.
      spoken+="Case "+(at+1)+" of "+cases.length+": "+safeVoice(picked.title,120)+". "+((await callingVoicePrompt(client,"1592g"))||selectCaseSpeech());
     }
    }else if(callingState.mode==="phone"){
     mode="article";
     spoken+=await voicePrompt("1592h",phoneEntrySpeech());
    }else if(callingState.mode==="fill-outcome"){
     mode="menu";
     spoken+=await voicePrompt("1592i",fillOutcomeSpeech());
    }else if(callingState.mode==="fill-amount"){
     mode="article";
     spoken+=await voicePrompt("1592j",fillAmountSpeech());
    }else if(callingState.mode==="fill-method"){
     mode="menu";
     spoken+=await voicePrompt("1592w",fillMethodSpeech());
    }else if(callingState.mode==="fill-paid"){
     mode="menu";
     spoken+=await voicePrompt("1592x",fillPaidSpeech());
    }else if(callingState.mode==="fill-paid-amount"){
     mode="article";
     spoken+=await voicePrompt("1592y",fillPaidAmountSpeech());
    }else if(callingState.mode==="pickup-address"){
     mode="menu";
     spoken+=await voicePrompt("1592z",pickupAddressSpeech());
    }else if(callingState.mode==="fill-note"){
     mode="menu";
     spoken+=await voicePrompt("1592k",fillNoteSpeech());
    }else if(callingState.mode==="fill-mood"){
     mode="menu";
     spoken+=await voicePrompt("1592l",fillMoodSpeech());
    }else if(callingState.mode==="date-choice"){
     mode="menu";
     spoken+=await voicePrompt("1592m",dateChoiceSpeech());
    }else if(["date-day","date-month","date-year","date-hour","date-minute"].includes(callingState.mode)){
     mode="article";
     const jewish=callingState.dateKind==="jewish";
     if(callingState.mode==="date-day"){
      // Numeric order is month-first (unlike Tishl, where day is first).
      spoken+=!jewish
       ?"Enter the month as a number, 1 for January through 12 for December, then press pound. Press star to go back."
       :"Enter the day of the Jewish month, 1 to 30, then press pound. Press star to go back.";
     }else if(callingState.mode==="date-month"){
      if(jewish){
       const nowParts=tzParts(new Date(),TISHL_TZ);
       const todayHebrew=hebrewFromGregorian(nowParts.year,nowParts.month,nowParts.day);
       spoken+=callingHebrewMonthChoicesSpeech(todayHebrew.year)+" Enter the month number, then press pound. Press star to go back.";
      }else spoken+="Enter the day of the month, 1 to 31, then press pound. Press star to go back.";
     }else if(callingState.mode==="date-year"){
      spoken+=await voicePrompt("1592n",dateYearSpeech(callingState.dateKind||"numeric"));
     }else if(callingState.mode==="date-hour")spoken+="Enter the hour, 0 to 23, then press pound. Press star to go back.";
     else spoken+="Enter the minute, 0 to 59, then press pound. Press star to go back.";
    }else if(callingState.mode==="confirm-delete"){
     mode="menu";
     spoken+=await voicePrompt("1592o","Press 3 again to delete this item, or any other key to cancel.");
    }else if(callingState.mode==="confirm-delete-all"){
     mode="menu";
     spoken+=await voicePrompt("1592p","Press 3 again to delete all log entries, or any other key to cancel.");
    }else{
     mode="menu";
     spoken+=await voicePrompt("1592",callingMenuSpeech(provider));
    }
   }
  }else if(path==="1593"){
   // Categories. Same gate as the 1591/1592 render (defense in depth):
   // on SignalWire the digit gate is bypassed via treeSelect, so this
   // branch re-checks the link.
   const verified=!!userId&&await memberAllowed(client,{...s,member_id:userId});
   const accessRow=verified?(await client.query<{status:string}>(
    "SELECT status FROM public.gavhah_olam_chesed_access WHERE user_id=$1",[userId])).rows[0]:null;
   if(!verified||accessRow?.status!=="linked"){
    path="159";categoriesState=null;page=0;confirmId=null;
    spoken=!verified
     ?"Olam Chesed Communication is a separate SignalWire service. To apply, securely link your Gavhah account under My Askanus option 2 then 5, or fill the website access request form. Press zero to go back."
     :"Your Olam Chesed request is "+(accessRow?.status==="requested"?"awaiting administration":accessRow?.status==="reviewing"?"under review":"not approved")+". Press 1 to send an access request to administration. Press zero to go back.";
   }else{
    if(!categoriesState)categoriesState=newCategoriesState();
    const {values,contacts}=await loadCategoriesList(client,userId!,categoriesState);
    page=categoriesState.pos;
    if(categoriesState.mode==="menu"){
     mode="menu";
     spoken+=await voicePrompt("1593",categoriesMenuSpeech());
    }else if(categoriesState.mode==="values"){
     mode="menu";
     if(!values.length){
      categoriesState={...categoriesState,mode:"menu",dimension:undefined,valuePos:undefined,pos:0};
      // Own key (1593d), NOT 1593b: 1593b is the LIST-empty message
      // ("no contacts in this category") and its draft tts_text would
      // override this values-empty message if shared.
      spoken+=await voicePrompt("1593d","There are no categories here yet. ");
     }else{
      const at=Math.min(categoriesState.valuePos??0,values.length-1);
      const value=values[at];
      spoken+=describeCategoryValue(value.label,at,values.length);
     }
    }else if(categoriesState.mode==="amount-entry"){
     mode="article";
     spoken+=await voicePrompt("1593a",amountEntrySpeech());
    }else if(categoriesState.mode==="list"){
     mode="menu";
     if(!contacts.length){
      spoken+=await voicePrompt("1593b","There are no contacts in this category. ");
     }else if(categoriesState.pos>=contacts.length){
      spoken+=await voicePrompt("1593c","You have reached the end of the list. Press pound to hear them again, or star to go back.");
     }else{
      const c=contacts[categoriesState.pos];
      confirmId=c.contactId;
      spoken+=describeCategoryContact(c.name,c.phone,c.detail+" ("+c.calls+(c.calls===1?" call":" calls")+")",categoriesState.pos,contacts.length);
     }
    }else{
     mode="menu";
     spoken+=await voicePrompt("1593",categoriesMenuSpeech());
    }
   }
  }else if(path==="159"||path.startsWith("159")){
   // Speed (2026-11-20): the member check and the Olam access lookup are
   // independent reads keyed by the same userId — fetch them in ONE query
   // instead of two sequential ones. The users WHERE clause mirrors
   // memberAllowed exactly; the pure gate (member_id + linked_until)
   // still runs first with no query, exactly as memberAllowed does.
   // olam_exists keeps the "row exists but status is NULL" case distinct
   // from "no row", so the spoken text below is unchanged.
   let verified=false;
   let row:{status:string|null}|null=null;
   if(!!userId&&!!s.linked_until&&new Date(s.linked_until).getTime()>=Date.now()){
    const both=await client.query<{verified:boolean;olam_status:string|null;olam_exists:boolean}>(
     "SELECT EXISTS(SELECT 1 FROM public.users WHERE id=$1 AND status NOT IN ('banned','suspended')) AS verified, "+
     "(SELECT status FROM public.gavhah_olam_chesed_access WHERE user_id=$1 LIMIT 1) AS olam_status, "+
     "EXISTS(SELECT 1 FROM public.gavhah_olam_chesed_access WHERE user_id=$1) AS olam_exists",[userId]);
    verified=both.rows[0]?.verified===true;
    row=verified&&both.rows[0]?.olam_exists?{status:both.rows[0]?.olam_status??null}:null;
   }
   if(!verified){
    path="159";
    spoken=feedback+"Olam Chesed Communication is a separate service. To apply, securely link your Gavhah account under My Askanus option 2 then 5, or fill the website access request form. Press zero to go back.";
   }else if(row?.status!=="linked"){
    path="159";
    spoken=feedback+(row
     ?"Your Olam Chesed request is "+(row.status==="requested"?"awaiting administration":row.status==="reviewing"?"under review":"not approved")+". "
     :"Your SignalWire Olam Chesed account is not linked. ");
    spoken+="Press 1 to send an access request to administration. Press zero to go back.";
   }else if(path==="159"){
    // NOTE: spoken starts as feedback (line ~926). Keep it: when a Tishl
    // action empties the queue the caller lands here and must still hear
    // e.g. "Done. ... Your Tishl is now empty." before the 159 menu.
    // Words like SignalWire/Yemot are replaced by safeVoice, so this text
    // (and the Tishl dial notice) avoids them entirely.
    spoken=feedback+"Your separate Olam Chesed account is marked linked. "+
     "For Tishl press 1. For Calling press 2. For Categories press 3. "+
     "These functions are handled by the Olam Chesed calling line, not this phone keypad. Press zero to go back.";
   }else{
    spoken=feedback+"This Olam Chesed function belongs to the separate calling service. "+
     "This phone menu cannot place calls. Open the Olam Chesed Communication website. Press zero to go back.";
   }
  }else if(path==="185"){
   mode="registration";
   const pending=await pendingPhoneSignup(client,callHash);
   spoken+=pending
    ? "Reenter your twelve to sixteen digit private password, then press pound. Press zero to cancel and return to the main menu. "
    : "Create a new Gavhah website member account by phone. Choose a PRIVATE twelve to sixteen digit numeric password. "+
      "Enter it now and press pound. You will need to enter it twice. After registration you will hear your ten digit member number. "+
      "On the website you can log in with M followed by that number, and the password you chose. "+
      "Phone account creation does not automatically create a separate Campaign Center Neon Auth account. "+
      "Press zero to cancel. ";
  }else if(path==="125"){
   mode="code";spoken+="Enter the eight digit code shown in My Askanus on your website. "+
    "Codes expire after five minutes. Never share it with others.";
   if(s.login_failures>=5){path="12";mode="menu";spoken="Too many attempts. Hang up and try again later. ";}
  }else if(path==="115"){
   if(confirmId===null){
    mode="article";spoken+="Enter a news article number to hear its full text. Press zero for the main menu.";
   }else{
    const prompt=await articlePrompt(client,confirmId,chunk);
    spoken+=prompt.text;contentAudio=prompt.audio;contentAudioPrefix=prompt.audioPrefix;
   }
  }else if(publicIdSections.has(path)){
   if(confirmId===null){
    mode="article";
    spoken+="Enter the public website item number, one to eight digits, then press pound. Press zero to return.";
   }else{
    spoken+=(await readPhonePublicById(client,path,confirmId,page)).text;
   }
  }else if(path==="116"){
   // News insert menu (Yakob 2026-11-20 04:46). The "press zero to
   // return" phrase also stops sendRead appending its back hint.
   mode="menu";
   spoken+="To insert an update with your own voice press 1. With the system voice press 2. To report an update to the system press 3. Press star to go back. Press zero to return to the main menu.";
  }else if(newsPath(path)){
   mode="news";
   const prompt=await newsPrompt(path,position,chunk);
   spoken+=prompt.text;contentAudio=prompt.audio;contentAudioPrefix=prompt.audioPrefix;
  }else if(path==="97021"){
   mode="news";
   const prompt=await discussionPrompt(position,chunk);
   spoken+=prompt.text;contentAudio=prompt.audio;contentAudioPrefix=prompt.audioPrefix;
  }else if(path==="97022"){
   if(confirmId===null){
    mode="article";spoken+="Enter a discussion number to hear it. Only discussions with a recording are on the phone. Press zero for the main menu.";
   }else{
    const prompt=await discussionByIdPrompt(client,confirmId,chunk);
    spoken+=prompt.text;contentAudio=prompt.audio;contentAudioPrefix=prompt.audioPrefix;
   }
  }else if(path==="97020"){
   // Discussions insert menu (rule 4): recordings ONLY — no system-voice
   // option here (that is updates only).
   mode="menu";
   spoken+="To open a new discussion with your own voice press 1. To report a discussion to the system press 3. Press star to go back. Press zero to return to the main menu.";
  }else if(path==="141"&&readManualResultPending(manualFlash)){
   // While choosing or confirming, speak only the active keypad instructions.
   // Do not repeat the entire contact queue or the menu customization.
   const pending=readManualResultPending(manualFlash)!;
   if(!feedback)spoken+=pending.stage==="choose"?choosePrompt:confirmationPrompt(pending);
  }else if(!fromNext&&!fromShared && (path==="14"||["141","142","143","144","1592","1599"].includes(path))){
   // Yemot NEVER places MAX outbound calls. Caller ID alone never confirms an account.
   const linkedMember=await memberAllowed(client,{...s,member_id:userId});
   if(!linkedMember){
    spoken="For Olam Chesed Communications, if you do not yet have an account, open the Gavhah website and fill out the Communications account application form. "+
     "If you already have a Gavhah account, sign in securely with your eight digit website code first. "+
     "Outgoing calls are on the separate Olam Chesed SignalWire hotline, not on Yemot. Press zero to return.";
   }else{
    const access=await client.query<{status:string}>(
      "SELECT status FROM public.gavhah_olam_chesed_access WHERE user_id=$1",[userId]);
    if(access.rows[0]?.status!=="linked"){
     spoken="Your Gavhah account is linked, but Olam Chesed Communications access has not been approved. "+
      "Open the Communications page on the Gavhah website and fill out the access application form. "+
      "For outgoing calls use only the Olam Chesed SignalWire hotline after approval. Press zero to return.";
    }else{
     spoken="Your Olam Chesed Communications account is approved. "+
      "To place outbound calls, use the separate Olam Chesed Communications SignalWire hotline or your calling desk on the website. "+
      "Call Assignments are available only to active members who joined a Campaign Center campaign. "+
      "This Yemot line does not place outgoing calls. Press zero to return.";
    }
   }
  }else if(sectionPaths.has(path)){
   const permitted=!sectionRequiresLogin.has(path)||
      await memberAllowed(client,{...s,member_id:userId});
   spoken+=await readPhoneSection(client,path,permitted?userId:null,page);
  }else if(path===GATE_PATH){
   // Login gate. The digit branch composes the full message (status +
   // prompt); this render appends the prompt only on first entry
   // (feedback empty). Input is the "registration" mode (rg, 1-16 digits)
   // because a 6-12 digit password does not fit the 8-digit code mode.
   mode="registration";
   if(s.login_failures>=5){path="";mode="menu";spoken+=gateText(GATE_LOCKED_YI,GATE_LOCKED_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("locked");}
   else if(!feedback){
    const gate=parseGateFlash(manualFlash);
    if(!gate){path="";spoken+="Please start again from the main menu. ";}
    else if(gate.needId){spoken+=gateText(GATE_NEED_ID_YI,GATE_NEED_ID_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("needId");}
    else if(gate.pendingUser){spoken+=gateText(GATE_PASSWORD_YI,GATE_PASSWORD_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("password");}
    else{spoken+=gateText(GATE_FIRST_YI,GATE_FIRST_EN,fromShared)+" ";gateAudioKey=gateAudioKeyForState("first");}
   }
  }else if(DEPT_FIRST_SCREEN[path]){
   // Live v117 first screens for the new departments (Askanim, private
   // help, Hitkabtzu, today's campaign, member contact, advanced
   // Askanus). These are NOT tree-generated menus: the live prompts are
   // prose with embedded options, so they are rendered verbatim here.
   // Their children (leaves under the 97xx branches) render via
   // menuPrompt details.
   mode="menu";
   spoken+=DEPT_FIRST_SCREEN[path];
  }else if(personalPaths.has(path)){
   if(!await memberAllowed(client,{...s,member_id:userId})){
    spoken="Your private account is not linked for this call. Open My Askanus on the website and generate an eight-digit code, then press 5 in this phone menu to sign in. If you do not have a website account, press zero to return, then press 8 at the welcome menu to register by phone.";
   }else{
    spoken+=await myPrompt(client,path,userId!,page,confirmId);
   }
  }else {
   if(!path && !from4444)mode="root";
   spoken+=menuPrompt(path,tree);
  }
  // Tishl state survives while the caller is on path 1591; it is cleared
  // when leaving Tishl (the digit branch sets tishlState=null then).
  // Calling state (+ held session id + pending voice note) survives the
  // same way while the caller is on path 1592. Categories state
  // survives the same way while the caller is on path 1593.
  if(path==="1591"&&tishlState)manualFlash=encodeTishlFlash(tishlState);
  if(path==="1592"&&callingState)manualFlash=encodeCallingFlashFull(callingState,callingSessionId,callingPending);
  if(path==="1593"&&categoriesState)manualFlash=encodeCategoriesFlash(categoriesState);
  // The gate flash survives while the caller is on the gate (120); every
  // other path clears it (a successful login clears it in the digit
  // branch, and leaving the gate via 0 clears it in the 0-branch).
  // The insert menus (116, 97020) keep their return-list path in
  // action_flash, so they are preserved like 141/1591/1592/1593/120.
  if(path!=="141"&&path!=="1591"&&path!=="1592"&&path!=="1593"&&path!==GATE_PATH&&path!=="116"&&path!=="97020")manualFlash="";
  // Speed (2026-11-20): the state save (this transaction) and the
  // menu-override lookup (a different table on a separate pooled
  // connection) are independent — run them concurrently instead of one
  // after another. The override is only consulted after both finish, so
  // what the caller hears is unchanged; a failure in either still rolls
  // the transaction back, exactly as before.
  const menuOverrideP=(mode==="menu"||mode==="root")&&!manualFlash&&!goToCampaignExtension&&!goToFolder64&&
    !feedback&&path!=="125"&&path!=="185"&&isNavigationalMenu(path,tree)
   ? phonePromptOverride(path)
   : Promise.resolve(null);
  const [,custom]=await Promise.all([
   client.query("UPDATE public.gavhah_yemot_call_states "+
   "SET step=$2,path=$3,news_position=$4,news_chunk=$5,phone_page=$6,selected_item_id=$7,member_id=$8,linked_until=$9,login_failures=$10,news_actions_open=$11,news_reply_mode=$12,news_reply_target=$13,news_report_mode=$14,action_flash=$15,updated_at=now() "+
   "WHERE call_hash=$1",[callHash,step,path,position,chunk,page,confirmId,userId,s.linked_until,s.login_failures,actionsOpen,replyMode,replyTarget,reportMode,manualFlash]),
   menuOverrideP,
  ]);
  // Menu-only overrides: never replace personal records, credentials, PIN,
  // monetary confirmations, news content, or other dynamic disclosures.
  // (publishedAudio was declared before the render; this block only
  // assigns it.)
  if(custom){
   // English-default rule (Yakob 2026-11-19 23:41): Yiddish text is
   // NEVER spoken as TTS — it is the recording's text only. The
   // override here is the row's English tts_text (the studio rejects
   // Hebrew tts_text); published audio wins via publishedAudio below.
   if(custom.ttsText)spoken=custom.ttsText;
   publishedAudio=custom.audioPath;
  }
  // Gate audio: when the gate state has a published pinchas recording,
  // it plays instead of the English gate text (and instead of the
  // welcome text after a successful login).
  if(gateAudioKey&&!publishedAudio){
   const gateOverride=await phonePromptOverride(gateAudioKey);
   if(gateOverride.audioPath)publishedAudio=gateOverride.audioPath;
  }
  if(process.env.OLAM_RETURN_CALL_ROUTING_ENABLED==="true"&&
     (fromShared||!fromNext)&&userId&&
     await memberAllowed(client,{...s,member_id:userId})){
   await client.query(
    "INSERT INTO public.max_agent_activity(user_id,channel,last_seen_at) "+
    "VALUES($1,$2,now()) ON CONFLICT(user_id) DO UPDATE SET "+
    "channel=EXCLUDED.channel,last_seen_at=now()",
    [userId,fromShared?"olam":"yemot"]);
   // A verified Yemot member hears a single notice on their next menu response.
   if(!fromShared&&mode!=="record"){
    const notice=await noteYemotReturnCalls(client,userId);
    spoken=notice+spoken;
    // Build B: the notice is CONSUMED even when a recording plays, so
    // fold it into the audio prefix — otherwise the caller never hears it.
    if(notice&&contentAudio)contentAudioPrefix=notice+(contentAudioPrefix||"");
   }
  }
  spoken=await applyFixedPhonePhraseEdits(client,fromShared?"signalwire":"yemot",spoken);
  await client.query("COMMIT");
  if(goToCampaignExtension){
   res.type("text/plain; charset=utf-8").set("Cache-Control","no-store").send("go_to_folder=/4444");
  }else if(goToFolder64){
   res.type("text/plain; charset=utf-8").set("Cache-Control","no-store").send("go_to_folder=/64");
  }else{
   // English-default rule (Yakob 2026-11-19 23:41): NO Hebrew-script
   // text is ever passed to a TTS voice. Every spoken prompt is a
   // published pinchas recording (publishedAudio) or English text.
   // safeVoice's allowHebrew flag is therefore never enabled here —
   // the flag stays in the utility for other callers, but this engine
   // always passes false.
   // The root (600 chars) and the gate first prompt (489) need the 950
   // cap — the old 430 cap cut both off mid-menu. Everything else keeps 430.
   const allowHebrew=false;
   // SignalWire cannot play an ivr2: file: on the shared route the caller
   // hears the English text; Yemot plays the published pinchas recording.
   // Build B: a news/discussion recording (contentAudio) wins over the
   // menu's pinchas prompt on Yemot; its prefix (headline + keys, plus
   // any return-call notice) is spoken before the file.
   const playAudio=fromShared?null:(contentAudio||publishedAudio);
   const playPrefix=contentAudio?contentAudioPrefix:null;
   sendRead(res,spoken,step,mode,playAudio,allowHebrew,(mode==="root"||path===GATE_PATH)?950:430,playPrefix);
  }
 }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
 finally{client.release();}
}
