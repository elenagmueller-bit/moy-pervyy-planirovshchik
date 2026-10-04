import { createGoogleAuthService } from "../js/google-auth.js?stage=6b";
import { canWriteCalendar, createGoogleCalendarService, normalizeGoogleEvent, stableGoogleEventId, taskToGoogleEvent } from "../js/google-calendar.js?stage=6";
import { renderWeekCalendar } from "../js/calendar-view.js?stage=6b";
import { deletePlannerDatabase, openPlannerDatabase } from "../js/db.js?stage=6";
import { createRepositories } from "../js/repositories.js?stage=6";

const results=[]; const list=document.querySelector("[data-results]");
const assert=(value,message="Проверка не пройдена")=>{if(!value) throw new Error(message)};
async function check(name,operation){try{await operation();results.push({name,passed:true})}catch(error){results.push({name,passed:false,error:error.message})}}
const jsonResponse=(status,payload)=>({ok:status>=200&&status<300,status,statusText:String(status),json:async()=>payload});
const task=(overrides={})=>({id:"550e8400-e29b-41d4-a716-446655440000",title:"Встреча",shortDescription:"Коротко",details:"Подробности",date:"2026-10-05",hasTime:true,startTime:"22:45",durationMinutes:90,priority:"high",category:"work",status:"active",tags:["важно"],links:[{label:"Документ",url:"https://example.com"}],checklist:[{text:"Подготовиться",isDone:false}],recurrence:null,revision:2,...overrides});

let currentNow=1_000_000; const authRequests=[]; let revokeToken=null;
const oauth2={
  initTokenClient(config){return{requestAccessToken(options){authRequests.push({scope:config.scope,options});config.callback({access_token:`token-${authRequests.length}`,expires_in:3600,scope:config.scope})}}},
  revoke(token,callback){revokeToken=token;callback()},
};
const auth=createGoogleAuthService({clientId:"client.apps.googleusercontent.com",oauth2,now:()=>currentNow});

await check("Google Identity Services: постепенные scopes и явный запрос",async()=>{
  await auth.requestReadAccess(); assert(auth.getState().canRead&&!auth.getState().canWrite); assert(authRequests[0].scope.includes("calendar.readonly")&&!authRequests[0].scope.includes("calendar.events"));
  await auth.requestWriteAccess(); assert(auth.getState().canRead&&auth.getState().canWrite); assert(authRequests[1].scope.includes("calendar.events")); assert(authRequests.every(item=>item.options.prompt===""));
});
await check("Токен живёт только в памяти и очищается",()=>{
  assert(auth.getAccessToken()==="token-2"); assert(!JSON.stringify({...localStorage}).includes("token-2")); auth.clear(); assert(auth.getAccessToken()===null&&!auth.getState().authenticated);
});
await check("Отзыв разрешения вызывает официальный revoke",async()=>{await auth.requestReadAccess(); await auth.revoke(); assert(revokeToken==="token-3"&&auth.getAccessToken()===null)});
await check("Поздняя загрузка Google Identity Services поддерживается",async()=>{const delayed=createGoogleAuthService({clientId:"client",now:()=>currentNow});globalThis.google={accounts:{oauth2}};await delayed.requestReadAccess();assert(delayed.getState().authenticated);delayed.clear();delete globalThis.google});

const calls=[];
const fetchMock=async(url,options={})=>{
  calls.push({url:String(url),options}); const parsed=new URL(url); const page=parsed.searchParams.get("pageToken");
  if(parsed.pathname.endsWith("/calendarList")) return jsonResponse(200,page?{items:[{id:"readonly",summary:"Праздники",accessRole:"reader",backgroundColor:"#aaaaaa"}]}:{items:[{id:"work",summary:"Работа",accessRole:"writer",backgroundColor:"#336699"}],nextPageToken:"p2"});
  if(parsed.pathname.endsWith("/events")&&options.method==="POST") return jsonResponse(200,{id:JSON.parse(options.body).id,etag:'"new"',updated:"2026-10-04T10:00:00Z"});
  if(parsed.pathname.endsWith("/events")) return jsonResponse(200,page?{items:[{id:"holiday",summary:"Праздник",start:{date:"2026-10-06"},end:{date:"2026-10-07"},htmlLink:"https://calendar.google.com/event?eid=2"}]}:{items:[{id:"meet",summary:"Совещание",description:"Описание",location:"Офис",start:{dateTime:"2026-10-05T08:00:00+03:00",timeZone:"Europe/Moscow"},end:{dateTime:"2026-10-05T09:30:00+03:00",timeZone:"Europe/Moscow"},attendees:[{self:true,responseStatus:"accepted"}],organizer:{email:"boss@example.com"},recurringEventId:"series",etag:'"1"',updated:"2026-10-01T00:00:00Z"}],nextPageToken:"next"});
  throw new Error(`Неожиданный запрос ${url}`);
};
const calendarAuth={getAccessToken:()=>"memory-token"}; const api=createGoogleCalendarService({auth:calendarAuth,fetchImpl:fetchMock});

await check("Список календарей загружается со всех страниц",async()=>{const values=await api.listCalendars();assert(values.length===2&&values[0].id==="work"&&values[1].accessRole==="reader");assert(calls.filter(call=>call.url.includes("calendarList")).length===2)});
await check("Права записи определяются по accessRole",()=>{assert(canWriteCalendar({accessRole:"writer"})&&canWriteCalendar({accessRole:"owner"})&&!canWriteCalendar({accessRole:"reader"}))});
await check("События загружаются постранично и нормализуются",async()=>{const calendar={id:"work",summary:"Работа",backgroundColor:"#336699"};const values=await api.listEvents(calendar,{timeMin:"2026-10-01T00:00:00+03:00",timeMax:"2026-11-01T00:00:00+03:00"});assert(values.length===2);assert(values[0].hasTime&&values[0].durationMinutes===90&&values[0].responseStatus==="accepted"&&values[0].recurringEventId==="series");assert(!values[1].hasTime&&values[1].title==="Праздник")});
await check("Частное событие не дополняется скрытыми полями",()=>{const value=normalizeGoogleEvent({id:"private",start:{date:"2026-10-05"},end:{date:"2026-10-06"}}, {id:"c",summary:"Личный"});assert(value.title==="Занято"&&value.description===""&&value.organizer==="")});
await check("Временная задача получает московское время и напоминание",()=>{const payload=taskToGoogleEvent(task());assert(payload.start.dateTime==="2026-10-05T22:45:00+03:00"&&payload.end.dateTime==="2026-10-06T00:15:00+03:00");assert(payload.reminders.overrides[0].minutes===10&&payload.description.includes("Чек-лист")&&payload.description.includes("#важно"));assert(!JSON.stringify(payload).includes("priority")&&!JSON.stringify(payload).includes("category"))});
await check("Задача без времени становится all-day",()=>{const payload=taskToGoogleEvent(task({hasTime:false,startTime:null,durationMinutes:null}));assert(payload.start.date==="2026-10-05"&&payload.end.date==="2026-10-06"&&!payload.start.dateTime)});
await check("Повторение превращается в RRULE",()=>{const payload=taskToGoogleEvent(task({recurrence:{frequency:"weekdays",weekdays:[1,3,5],endType:"count",count:8}}));assert(payload.recurrence[0]==="RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=8")});
await check("Стабильный Google event ID не меняется",()=>{const one=stableGoogleEventId(task().id);const two=stableGoogleEventId(task().id);assert(one===two&&/^[a-v0-9]{5,1024}$/.test(one))});
await check("INSERT отправляет стабильный ID и Bearer только в заголовке",async()=>{const event=await api.insertTask("work",task());const call=calls.find(item=>item.options.method==="POST");assert(event.id===stableGoogleEventId(task().id));assert(JSON.parse(call.options.body).id===event.id);assert(call.options.headers.Authorization==="Bearer memory-token"&&!call.url.includes("memory-token")&&!call.options.body.includes("memory-token"))});
await check("Повторный INSERT с 409 восстанавливает существующую связь",async()=>{let count=0;const duplicateApi=createGoogleCalendarService({auth:calendarAuth,fetchImpl:async(url,options={})=>{count+=1;if(options.method==="POST")return jsonResponse(409,{error:{message:"duplicate"}});return jsonResponse(200,{id:stableGoogleEventId(task().id),etag:'"exists"'})}});const event=await duplicateApi.insertTask("work",task());assert(count===2&&event.etag==='"exists"')});
await check("Google-события в календаре только для просмотра",()=>{
  const events=[
    {cacheKey:"c:multi",id:"multi",title:"Командировка",calendarName:"Работа",calendarColor:"#336699",date:"2026-10-05",endDate:"2026-10-08",hasTime:false,startTime:null,durationMinutes:null,status:"confirmed",isGoogleEvent:true},
    {cacheKey:"c:late",id:"late",title:"Поздняя встреча",calendarName:"Работа",calendarColor:"#336699",date:"2026-10-05",endDate:"2026-10-05",hasTime:true,startTime:"23:15",durationMinutes:30,status:"confirmed",isGoogleEvent:true},
  ]; let opened=null;const root=renderWeekCalendar(new Date("2026-10-05T12:00:00"),{tasks:[],googleEvents:events,onOpenGoogle:event=>{opened=event}});document.body.append(root);
  assert(root.querySelectorAll("[data-google-event-key='c:multi']").length===3);const chips=root.querySelectorAll(".calendar-google-event");assert(chips.length===4&&[...chips].every(chip=>!chip.draggable)&&!root.querySelector("[data-google-event-key] [data-resize-handle]"));chips[0].click();assert(opened?.id==="multi");root.remove();
});
await check("Исходный часовой пояс и etag Google сохраняются в кэше",()=>{const value=normalizeGoogleEvent({id:"x",etag:'"etag"',start:{dateTime:"2026-10-05T10:00:00+02:00",timeZone:"Europe/Zurich"},end:{dateTime:"2026-10-05T11:00:00+02:00",timeZone:"Europe/Zurich"}}, {id:"c",summary:"Швейцария"});assert(value.start.timeZone==="Europe/Zurich"&&value.etag==='"etag"')});

const dbName=`planner-stage6-${crypto.randomUUID()}`;const db=await openPlannerDatabase({name:dbName});const repos=createRepositories(db);
await check("Ошибка Google не отменяет локальное сохранение",async()=>{const local=await repos.tasks.create(task());const failing=createGoogleCalendarService({auth:calendarAuth,fetchImpl:async()=>jsonResponse(503,{error:{message:"temporary"}})});let failed=false;try{await failing.insertTask("work",local)}catch{failed=true}assert(failed&&(await repos.tasks.get(local.id)).title==="Встреча")});
await check("Отключение очищает кэш, но сохраняет задачу и eventId",async()=>{const local=(await repos.tasks.getAll())[0];await repos.tasks.update(local.id,{googleSync:{calendarId:"work",eventId:"event-1",etag:'"e"',syncStatus:"synced"}});await repos.googleEventsCache.put({cacheKey:"work:event-1",calendarId:"work",start:{date:"2026-10-05"},updated:""});await repos.syncState.put({calendarId:"work",nextSyncToken:"secret"});await repos.googleIntegration.disconnect(new Date("2026-10-04T12:00:00Z"));const kept=await repos.tasks.get(local.id);assert(kept.googleSync.eventId==="event-1"&&kept.googleSync.lastErrorCode==="GOOGLE_DISCONNECTED");assert((await repos.googleEventsCache.getAll()).length===0&&(await repos.syncState.getAll()).length===0)});
db.close();await deletePlannerDatabase(dbName);

auth.clear();
results.forEach(result=>{const item=document.createElement("li");item.className=result.passed?"passed":"failed";item.textContent=result.passed?`Пройдено: ${result.name}`:`Ошибка: ${result.name} — ${result.error}`;list.append(item)});
const passed=results.filter(item=>item.passed).length;document.querySelector("[data-summary]").textContent=`${passed} из ${results.length} проверок пройдено`;document.documentElement.dataset.testStatus=passed===results.length?"passed":"failed";window.__STAGE6_TEST_RESULTS__=results;
