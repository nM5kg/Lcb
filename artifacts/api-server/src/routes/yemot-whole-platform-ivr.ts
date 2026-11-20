import { Router, type Request, type Response } from "express";
import { handleYemotApp } from "../lib/yemot-api-driven-phone";
import {forwardCampaign4444} from "../lib/yemot-campaign-bridge";

// Complete PHONE NAVIGATION MAP, not a claim of completed phone features.
// The menu currently ONLY names modules. Caller phone numbers are NOT identity.
type Item = { label: string; details?: string; web?: string; children?: Record<string, Item>; phone: "menu" | "roadmap" };
const group=(label:string,children:Record<string,Item>):Item=>({label,children,phone:"menu"});
const leaf=(label:string,web:string,details="This module is mapped. Private actions require a separately verified telephone sign-in."):Item=>({label,web,details,phone:"roadmap"});
export const phoneTree: Record<string,Item> = {
  "1":group("Gavhah. Global Kindness Network",{
    "1":group("News and updates — wait for all updates, press 1 for options",{
      "1":leaf("All updates, newest first","/news"),
      "3":leaf("Important and critical news","/news"),
      "4":leaf("Featured updates","/news"),
      "5":leaf("Read an update by its article number","/news/:id")
    }),
    "2":group("My Askanus and MAX",{
      "1":leaf("My tasks, including marking complete","/my"),
      "2":leaf("My personal cases and goals","/my"),
      "3":leaf("My private notes","/my"),
      "4":leaf("My personal dashboard","/my"),
      "5":leaf("Securely link my website account by eight-digit code","/my"),
      "6":leaf("Log out of this phone session","/my")
    }),
    "3":group("People and contacts",{
      "1":leaf("Donor 360","/communications"),"2":leaf("Contacts","/communications"),
      "3":leaf("Pledges and receipts","/communications"),"4":leaf("Follow ups","/communications")
    }),
    "4":group("Calling center",{
      "1":leaf("My call queue","/communications"),"2":leaf("Call history","/communications"),
      "3":leaf("Calling permissions","/communications"),"4":leaf("Caller ID and provider status","/communications")
    }),
    "5":group("Kindness and help",{
      "1":leaf("Charity and campaigns","/charity"),"2":leaf("Ask for assistance","/united"),
      "3":leaf("Volunteer to help","/united"),"4":leaf("Community projects","/community-projects"),
      "5":leaf("Read a public charity campaign by its website number","/charity/:id"),
      "9":group("Olam Chesed Communication — SignalWire account gateway",{
        "1":leaf("Tishl — live calling desk","/communications"),
        "2":leaf("Call access and account information","/communications"),
        "3":leaf("Donor 360 and contacts","/communications"),
        "4":leaf("Pledges and donation tracking","/communications"),
        "5":leaf("Follow ups and callbacks","/communications"),
        "6":leaf("Virtual fundraising floor and conferences","/communications"),
        "7":leaf("Team, guidance and administration","/communications"),
        "8":leaf("Reports and activity history","/communications"),
        "9":leaf("Account support and access application","/communications")
      })
    }),
    "6":group("Community",{
      "1":leaf("Groups","/groups"),"2":leaf("Discussion forum","/forum"),
      "3":leaf("Directory","/directory"),"4":leaf("Connections","/connections"),
      "5":leaf("Create a forum post","/forum/new"),"6":leaf("Read a selected forum topic","/forum/:id"),
      "7":leaf("Open a selected group","/groups/:id")
    }),
    "7":group("Minyans and appointments",{
      "1":leaf("Minyan directory","/minyans"),"2":leaf("Reservations","/reservations"),
      "3":leaf("Read an approved minyan by its website number","/minyans/:id")
    }),
    "8":group("Messages and account",{
      "1":leaf("Notifications","/notifications"),"2":leaf("My profile","/profile"),
      "3":group("Search public records by website number",{
      "1":leaf("Find a published charity campaign by number","/charity/:id"),
      "2":leaf("Find a public forum topic by number","/forum/:id"),
      "3":leaf("Find a public group by number","/groups/:id"),
      "4":leaf("Find an approved minyan by number","/minyans/:id"),
      "5":leaf("Website search for more topics and names","/search","For text searches and other topics, use the website search page. Press zero to return to the main menu.")
    }),"4":leaf("Sign in or link my account","/login","For an existing Gavhah website account choose My Askanus, then press 5 and enter your one-time website pairing code. To create a new member entirely on the phone press 5 in this account menu."),
      "5":leaf("Create a Gavhah website member by phone","/register","Real keypad signup: choose and confirm your twelve to sixteen digit secret code to receive a member ID beginning with M. Website login accepts this member ID and your chosen code. Not a Campaign Center account."),"6":leaf("Privacy information","/privacy"),
      "7":leaf("Terms and conditions","/terms"),"8":leaf("Gavhah welcome homepage","/")
    }),
    "9":group("Management and reports",{
      "1":leaf("Personal overview","/dashboard"),"2":leaf("System center","/system"),
      "3":leaf("Super administrator","/founder"),
      "4":leaf("Group and staff settings","/group-team"),
      "5":leaf("SignalWire provider connection, WEBSITE ONLY","/founder/signalwire","API tokens and provider credentials must NEVER be spoken over the phone. This protected administration setting requires secure website authentication.")
    })
  }),
  // TRUE 16-department menu (live v117): the studio rootChoices() paths
  // 9702/9703/9704/9706/9708/9716/97190/97193 as REAL tree branches.
  // Paths starting with "9" are never entered digit-by-digit from the root
  // (no root digit maps to "9..."); the root map in true-menu.ts jumps
  // straight to them, and treeSelect/menuPrompt walk them digit-by-digit
  // from there. The intermediate "9"/"97"/"970"/"971" nodes are structural
  // only: pressing 0 inside a 97xx department returns to the root (see
  // handleYemotApp), never to an intermediate node.
  // Children of 9708/97193/9703 are LISTING labels for menuPrompt; the digit
  // branch in handleYemotApp redirects them to the real sections
  // (161/162/163/164, 164/153/152, 132). Children of 97190 are aliases of
  // the public-by-number sections (see yemot-section-batch1.ts).
  "9":group("Gavhah departments by number",{
    "7":group("Departments",{
      "0":group("Departments",{
        "2":group("Askanim discussions",{
          "1":leaf("All discussions, newest first","/forum"),
          "2":leaf("Read a discussion by its number","/forum/:id")
        }),
        "3":group("Private help requests",{
          "1":leaf("Help options","/united","Private help options are not yet available on the phone. Use the website to ask for assistance. Press zero to return to the main menu."),
          "9":leaf("Private connections","/communications","Your private Gavhah connections.")
        }),
        "4":group("Hitkabtzu Letovah",{
          "1":leaf("Join the cause","/charity","Joining the cause by phone is not yet available. Use the website. Press zero to return to the main menu."),
          "2":leaf("Submit a proposal for team review","/charity","Submitting a proposal by phone is not yet available. Use the website. Press zero to return to the main menu.")
        }),
        "6":group("Today's charity campaign",{
          "2":leaf("Suggest a cause","/charity","Suggesting a cause by phone is not yet available. Use the website. Press zero to return to the main menu.")
        }),
        "8":group("Community groups",{
          "1":leaf("Groups","/groups","Public community groups."),
          "2":leaf("Discussion forum","/forum","Public discussion forum."),
          "3":leaf("Directory","/directory","Public directory."),
          "4":leaf("Connections","/connections","Your connections.")
        })
      }),
      "1":group("Departments",{
        "6":group("Contact a member by ID",{
          "1":leaf("Contact a member","/directory","Contacting a member by ID from the phone is not yet available. Use the website directory. Press zero to return to the main menu."),
          "2":leaf("How it works","/directory","To contact a Gavhah member, enter their member ID on the website directory. Press zero to return to the main menu.")
        }),
        "9":group("Search and connections",{
          "0":group("Search public records by Gavhah account number",{
            "1":leaf("Find a published charity campaign by number","/charity/:id"),
            "2":leaf("Find a public forum topic by number","/forum/:id"),
            "3":leaf("Find a public group by number","/groups/:id"),
            "4":leaf("Find an approved minyan by number","/minyans/:id"),
            "5":leaf("Gavhah account search for more topics and names","/search","For text searches and other topics, use the website search page. Press zero to return to the main menu.")
          }),
          "3":group("My Connections",{
            "1":leaf("Connections list","/connections","Your connections list."),
            "2":leaf("Volunteer application","/united","Volunteer application."),
            "3":leaf("Help from Askanim","/united","Help from Askanim.")
          })
        })
      })
    })
  }),
  "2":group("Campaign Center",{
    "1":group("Campaigns",{
      "1":leaf("My campaigns","/"),"2":leaf("Campaign dashboard","/"),
      "3":leaf("Campaign goals and status","/"),"4":leaf("Campaign settings","/")
    }),
    "2":group("Tasks and follow ups",{
      "1":leaf("My work today","/"),"2":leaf("Assigned tasks","/"),
      "3":leaf("Callbacks and follow ups","/"),"4":leaf("Activity history","/")
    }),
    "3":group("Contacts and calls",{
      "1":leaf("Donor contacts","/"),"2":leaf("Call lists","/"),
      "3":leaf("Claim or release a lead","/"),"4":leaf("Manual call results","/"),
      "5":leaf("Do Not Call protection","/")
    }),
    "4":group("Donations and finance",{
      "1":leaf("Pledges","/"),"2":leaf("Manual receipts","/"),
      "3":leaf("Net campaign reporting","/"),"4":leaf("Corrections and audit","/")
    }),
    "5":group("Teams and members",{
      "1":leaf("Team dashboard","/"),"2":leaf("Squads and departments","/"),
      "3":leaf("Invitations and permissions","/"),"4":leaf("Member progress","/")
    }),
    "6":group("Virtual fundraising hall",{
      "1":leaf("Open fundraising hall","/"),"2":leaf("Live room check in","/"),
      "3":leaf("Program schedule","/"),"4":leaf("Help desk","/"),
      "5":leaf("Audio or video stream","/")
    }),
    "7":group("Hitkabtzu conferences",{
      "1":leaf("Conference directory","/"),"2":leaf("Join an assembly","/"),
      "3":leaf("Speaker controls","/"),"4":leaf("Access and moderation","/")
    }),
    "8":group("Reports and management",{
      "1":leaf("Manager overview","/"),"2":leaf("Activity log","/"),
      "3":leaf("Export or import","/"),"4":leaf("Campaign accounting","/")
    }),
    "9":group("Plans and connections",{
      "1":group("Six upgrade plans",{
        "1":leaf("Askan Plus plan","/"),
        "2":leaf("Chesed Quick plan","/"),
        "3":leaf("Askan Pro plan","/"),
        "4":leaf("Gabbai Pro plan","/"),
        "5":leaf("Organization plan","/"),
        "6":leaf("Custom plan","/")
      }),"2":leaf("Gavhah MAX Connect","/"),
      "3":leaf("Central Yemot phone status","/"),"4":leaf("Special integrations","/")
    })
  })
};
export function phoneNode(path:string):Item|undefined {
  let current:Item|undefined;
  let children=phoneTree;
  for(const part of path){
    current=children[part];
    if(!current)return;
    children=current.children||{};
  }
  return current;
}
export function phonePrompt(path:string):string {
  const children=path ? phoneNode(path)?.children : phoneTree;
  if(!children)return "This option is not available.";
  const pre=path==="1" ? "Gavhah." : path==="2" ? "Campaign Center." : path==="" ? "Welcome to Gavhah and Campaign Center." : "";
  const choices=Object.entries(children).map(([digit,item])=>"Press "+digit+" for "+item.label+".").join(" ");
  return [pre,choices,path?"Press zero to go back.":""].filter(Boolean).join(" ").replace(/[&=,\r\n]/g," ").slice(0,1200);
}
const router=Router();
// Exactly one Yemot API callback; all menus, filters, and per-call steps live
// in our own application and Neon DB. No provider-side child menu required.
router.all("/yemot/ivr",(req:Request,res:Response,next)=>{
  void handleYemotApp(req,res,phoneTree).catch(next);
});
// Campaign Center on the old line is a separate, authenticated /4444 callback.
router.all("/yemot/ivr/4444",(req:Request,res:Response,next)=>{
  // Roll out safely: old read-only Campaign menu until BOTH services have
  // the deliberately configured shared secret; then use CC's separate DB.
  const connected=(process.env.CC_GAVHAH_BRIDGE_SECRET||"").length>=40;
  void (connected?forwardCampaign4444(req,res):handleYemotApp(req,res,phoneTree)).catch(next);
});
// Isolated replacement-line sandbox: same Gavhah logic and Neon data,
// DIFFERENT callback digest; does not invoke Yemot provider settings.
router.all("/yemot/next-ivr",(req:Request,res:Response,next)=>{
  void handleYemotApp(req,res,phoneTree).catch(next);
});
export default router;
