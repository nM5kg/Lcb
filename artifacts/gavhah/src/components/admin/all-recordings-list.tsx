import {useEffect,useMemo,useState} from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";

type Saved={path:string;tts_text:string|null;audio_size:number|null;published_path:string|null;published_at:string|null;updated_at:string;yiddish_text:string|null;voice:string|null;language:string|null};
type StudioResponse={prompts:Saved[]};

async function req(path:string){
 const response=await fetch("/api/admin/yemot/voice-studio"+path,{
  cache:"no-store",credentials:"include",
  headers:{"Content-Type":"application/json"}
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||"דער פארלאנג איז נישט געלונגען");
 return data;
}

type Group="all"|"root"|"gate"|"tishl"|"calling"|"categories"|"other";
function groupOf(path:string):Exclude<Group,"all">{
 if(path==="root")return "root";
 if(path.startsWith("120"))return "gate";
 if(path.startsWith("1591"))return "tishl";
 if(path.startsWith("1592"))return "calling";
 if(path.startsWith("1593"))return "categories";
 return "other";
}
const groupLabels:Record<Exclude<Group,"all">,string>={
 root:"הויפט־מעניו",
 gate:"טויער 120",
 tishl:"טישל 1591",
 calling:"קאלינג 1592",
 categories:"קאַטעגאָריעס 1593",
 other:"אנדערע",
};

export function AllRecordingsList(){
 const [prompts,setPrompts]=useState<Saved[]|null>(null);
 const [error,setError]=useState("");
 const [filter,setFilter]=useState("");
 const [group,setGroup]=useState<Group>("all");
 const [pub,setPub]=useState<"all"|"published"|"draft">("all");
 const [playing,setPlaying]=useState<string|null>(null);
 useEffect(()=>{void req("?data=1").then((v:StudioResponse)=>setPrompts(v.prompts||[])).catch(e=>setError(e instanceof Error?e.message:"אומבאקאנטער פעלער"));},[]);
 const counts=useMemo(()=>{
  const list=prompts||[];
  return {
   total:list.length,
   published:list.filter(p=>p.published_path).length,
   withAudio:list.filter(p=>p.audio_size).length,
  };
 },[prompts]);
 const shown=useMemo(()=>{
  const q=filter.trim().toLowerCase();
  return (prompts||[]).filter(p=>{
   if(group!=="all"&&groupOf(p.path)!==group)return false;
   if(pub==="published"&&!p.published_path)return false;
   if(pub==="draft"&&p.published_path)return false;
   if(!q)return true;
   return (p.path+" "+(p.yiddish_text||"")+" "+(p.tts_text||"")).toLowerCase().includes(q);
  });
 },[prompts,filter,group,pub]);
 return <div dir="rtl" lang="yi" className="space-y-5 max-w-6xl">
  <div className="rounded-xl border p-4 space-y-2 bg-card">
   <h3 className="font-bold text-lg">🎙️ אַלע רעקאָרדירונגען — יידיש און ענגליש</h3>
   <p className="text-sm text-muted-foreground">
    דא זעט מען אַלע רעקאָרדירונגען וואָס די סיסטעם פאַרמאָגט: פֿאַר יעדן וועג
    דאָס יידישע וואָרט און דאָס ענגלישע וואָרט, און צי די פּנחס־שטימע איז
    שוין פּובליצירט אויף ימות. דאָס איז בלויז אַ ליסטע — גאָרנישט ווערט
    דאָ געטוישט אָדער פּובליצירט.
   </p>
   <p className="text-sm">
    אַלץ צוזאַמען: <strong>{counts.total}</strong> · פּובליצירט אויף ימות: <strong>{counts.published}</strong> · נאָך נישט פּובליצירט: <strong>{counts.total-counts.published}</strong> · מיט אַודיאָ־טיוטע: <strong>{counts.withAudio}</strong>
   </p>
   {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
  </div>
  <div className="rounded-xl border p-4 space-y-3 bg-card">
   <Input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="זוך לויט וועג, יידיש אָדער ענגליש..." />
   <div className="flex flex-wrap gap-2 items-center">
    <label className="text-sm">גרופּע:
     <select className="border rounded-lg bg-background p-2 mr-2" value={group} onChange={e=>setGroup(e.target.value as Group)}>
      <option value="all">אַלע</option>
      {(Object.keys(groupLabels) as Exclude<Group,"all">[]).map(g=><option key={g} value={g}>{groupLabels[g]}</option>)}
     </select>
    </label>
    <label className="text-sm">פּובליצירט:
     <select className="border rounded-lg bg-background p-2 mr-2" value={pub} onChange={e=>setPub(e.target.value as "all"|"published"|"draft")}>
      <option value="all">אַלע</option>
      <option value="published">נאָר פּובליצירטע</option>
      <option value="draft">נאָר נישט פּובליצירטע</option>
     </select>
    </label>
    <span className="text-sm text-muted-foreground">געוויזן: <strong>{shown.length}</strong> פון {counts.total}</span>
    <Button variant="outline" size="sm" onClick={()=>void req("?data=1").then((v:StudioResponse)=>setPrompts(v.prompts||[])).catch(e=>setError(e instanceof Error?e.message:"אומבאקאנטער פעלער"))}>דערפרישן</Button>
   </div>
  </div>
  {!prompts&&!error&&<p className="text-sm text-muted-foreground">לאָדט...</p>}
  {prompts&&shown.length===0&&<p className="text-sm text-muted-foreground">קיין רעקאָרדירונג געפונען פֿאַר דעם זוך.</p>}
  <div className="space-y-3">
   {shown.map(p=>{
    const published=!!p.published_path;
    const file=p.published_path?.split("/").pop()||"";
    return <div key={p.path} className="rounded-xl border p-4 space-y-2 bg-card">
     <div className="flex flex-wrap items-center gap-2">
      <code dir="ltr" className="font-bold">/{p.path}</code>
      <span className="text-xs rounded-full border px-2 py-0.5">{groupLabels[groupOf(p.path)]}</span>
      {p.language&&<span className="text-xs rounded-full border px-2 py-0.5" dir="ltr">{p.language}</span>}
      {p.voice&&<span className="text-xs rounded-full border px-2 py-0.5" dir="ltr">{p.voice}</span>}
      <span className={"text-xs rounded-full border px-2 py-0.5 font-semibold "+(published?"text-green-700":"text-amber-700")}>{published?"באשטעטיגט אויף ימות":"נאך נישט פובליצירט"}</span>
      {published&&file&&<span className="text-xs text-muted-foreground" dir="ltr">/897/{file}</span>}
     </div>
     <div className="grid md:grid-cols-2 gap-3">
      <div>
       <p className="text-xs font-semibold text-muted-foreground">יידיש</p>
       <p className="text-sm whitespace-pre-wrap">{p.yiddish_text?.trim()||"—"}</p>
      </div>
      <div>
       <p className="text-xs font-semibold text-muted-foreground">ענגליש</p>
       <p dir="ltr" lang="en" className="text-sm whitespace-pre-wrap text-right">{p.tts_text?.trim()||"—"}</p>
      </div>
     </div>
     <div className="flex flex-wrap items-center gap-2">
      {p.audio_size
       ?<Button size="sm" variant="outline" onClick={()=>setPlaying(playing===p.path?null:p.path)}>{playing===p.path?"באַהאַלטן אַודיאָ":"▶ הערן"}</Button>
       :<span className="text-xs text-muted-foreground">קיין אַודיאָ־טיוטע</span>}
      {p.audio_size&&<span className="text-xs text-muted-foreground">{Math.round(p.audio_size/1024)} KB</span>}
      {p.published_at&&<span className="text-xs text-muted-foreground">פּובליצירט: {new Date(p.published_at).toLocaleString()}</span>}
     </div>
     {playing===p.path&&p.audio_size&&<audio controls preload="none" className="w-full" src={"/api/admin/yemot/voice-studio/"+encodeURIComponent(p.path)+"/audio"} />}
    </div>;
   })}
  </div>
 </div>;
}
