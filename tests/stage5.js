import { backupFileName, clearLocalData, createBackup, importBackup, importPreview, parseBackup } from "../js/backup.js?stage=5b";
import { deletePlannerDatabase, openPlannerDatabase } from "../js/db.js?stage=5b";
import { createNoteViewer } from "../js/forms.js?stage=5b";
import { createRepositories, filterNotes, sortNotes } from "../js/repositories.js?stage=5b";
import { searchPlanner } from "../js/search.js?stage=5b";

const results=[]; const list=document.querySelector("[data-results]");
const assert=(value,message="Проверка не пройдена")=>{if(!value) throw new Error(message)};
async function check(name,operation){try{await operation();results.push({name,passed:true})}catch(error){results.push({name,passed:false,error:`${error.message}${error.errors?` ${JSON.stringify(error.errors)}`:""}`})}}
const noteInput=(overrides={})=>({title:"Важная заметка",text:"Позвонить в Цюрих",category:"personal",priority:"medium",isPinned:false,tags:["Связь"],links:[{label:"Сайт",url:"https://example.com"}],...overrides});
const taskInput=(overrides={})=>({title:"Задача",shortDescription:"",details:"",date:"2026-10-05",hasTime:false,startTime:null,durationMinutes:null,priority:"medium",category:"personal",status:"active",tags:[],links:[],checklist:[],recurrence:null,...overrides});
const dbName=`planner-stage5-${crypto.randomUUID()}`; const db=await openPlannerDatabase({name:dbName}); const repos=createRepositories(db);
let note;

await check("Создание, поля и закрепление заметки",async()=>{
  note=await repos.notes.create(noteInput(),new Date("2026-10-04T08:00:00Z"));
  assert(note.title==="Важная заметка"&&note.tags[0]==="Связь"&&note.links[0].url==="https://example.com");
  note=await repos.notes.pin(note.id,true,new Date("2026-10-04T08:01:00Z"));
  assert(note.isPinned&&note.revision===2&&(await repos.notes.get(note.id)).isPinned);
  let tooLong=false; try{await repos.notes.create(noteInput({text:"а".repeat(20001)}))}catch(error){tooLong=Boolean(error.errors?.text)} assert(tooLong,"Длинный текст должен быть отклонён");
});
await check("Архив, корзина, восстановление и окончательное удаление",async()=>{
  const item=await repos.notes.create(noteInput({title:"Жизненный цикл"}));
  assert((await repos.notes.archive(item.id)).archivedAt);
  assert(!(await repos.notes.restoreFromArchive(item.id)).archivedAt);
  assert((await repos.notes.moveToTrash(item.id)).trashedAt);
  assert(!(await repos.notes.restoreFromTrash(item.id)).trashedAt);
  await repos.notes.moveToTrash(item.id); await repos.notes.deleteForever(item.id); assert(!(await repos.notes.get(item.id)));
});
await check("Закреплённые сортируются в своём блоке",async()=>{
  const values=[
    await repos.notes.create(noteInput({title:"Низкий",priority:"low",isPinned:true}),new Date("2026-01-01T00:00:00Z")),
    await repos.notes.create(noteInput({title:"Высокий",priority:"high",isPinned:true}),new Date("2026-01-02T00:00:00Z")),
    await repos.notes.create(noteInput({title:"Обычный",priority:"medium"}),new Date("2026-01-03T00:00:00Z")),
  ];
  const pinned=sortNotes(filterNotes(values,{pinned:"yes"}),"priority"); assert(pinned.map(item=>item.title).join()==="Высокий,Низкий");
});
await check("HTML-подобный текст выводится как обычный текст",async()=>{
  const unsafe=await repos.notes.create(noteInput({title:"<img src=x onerror=alert(1)>",text:"<script>window.bad=true</script>"}));
  const view=createNoteViewer(unsafe,[]); document.body.append(view);
  assert(!view.querySelector("script")&&!view.querySelector("img")&&view.textContent.includes("<script>")); view.remove(); assert(!window.bad);
});
await check("Заметка превращается в задачу и архивируется",async()=>{
  const source=await repos.notes.create(noteInput({title:"В задачу",text:"Подробности",priority:"high",category:"work",tags:["Отчёт"]}));
  const result=await repos.notes.convertToTask(source.id,taskInput({title:source.title,details:source.text,priority:source.priority,category:source.category,tags:source.tags}));
  assert(result.task.title==="В задачу"&&result.task.details==="Подробности"&&result.task.priority==="high"&&result.note.archivedAt);
});
await check("Ошибка создания задачи не архивирует заметку",async()=>{
  const existing=await repos.tasks.create(taskInput({id:"duplicate-task"}));
  const source=await repos.notes.create(noteInput({title:"Останусь"}));
  let failed=false; try{await repos.notes.convertToTask(source.id,taskInput({id:existing.id,title:"Дубликат"}))}catch{failed=true}
  assert(failed&&!(await repos.notes.get(source.id)).archivedAt);
});
await check("Поиск: поля, ё/е, регистр и порог длины",()=>{
  const tasks=[taskInput({id:"t",title:"Ёлка",shortDescription:"Кратко",details:"Детали",tags:["Метка"],checklist:[{text:"Пункт"}],links:[{label:"Документ",url:"https://host/path"}]})];
  const notes=[{...noteInput({title:"Заметка",text:"Швейцария"}),id:"n"}];
  for(const query of ["елка","КРАТКО","детали","метка","пункт","документ","host/path"]) assert(searchPlanner({tasks,notes},query).tasks.length===1,query);
  assert(searchPlanner({tasks,notes},"шв").notes.length===1); assert(!searchPlanner({tasks,notes},"е").active); assert(searchPlanner({tasks,notes},"е",{force:true}).tasks.length===1);
});
await check("Архив и корзина входят в поиск только явно",()=>{
  const tasks=[taskInput({id:"a",title:"Скрыто",archivedAt:"2026-01-01T00:00:00Z"}),taskInput({id:"b",title:"Скрыто",trashedAt:"2026-01-01T00:00:00Z"})];
  assert(searchPlanner({tasks},"скрыто").tasks.length===0);
  assert(searchPlanner({tasks},"скрыто",{includeArchive:true}).tasks.length===1);
  assert(searchPlanner({tasks},"скрыто",{includeTrash:true}).tasks.length===1);
});
await check("Поиск по 10 000 объектов укладывается в целевой предел",()=>{
  const notes=Array.from({length:10000},(_,index)=>({id:String(index),title:`Запись ${index}`,text:index===9999?"контрольное слово":"обычный текст",tags:[],links:[]}));
  const started=performance.now(); const found=searchPlanner({notes},"контрольное"); const elapsed=performance.now()-started;
  assert(found.notes.length===1&&elapsed<500,`Поиск занял ${elapsed.toFixed(0)} мс`);
});
await check("Экспорт имеет UTC-имя и не содержит служебных stores/секретов",async()=>{
  await repos.settings.put({id:"app",theme:"one",accessToken:"secret",syncToken:"secret2"});
  const backup=await createBackup(db,new Date("2026-08-12T08:00:00Z")); const text=JSON.stringify(backup);
  assert(backupFileName(new Date("2026-08-12T08:00:00Z"))==="planner-backup-20260812T080000Z.json");
  assert(!text.includes("secret")&&!text.includes("googleEventsCache")&&!text.includes("syncState")&&!text.includes("conflictHistory"));
});
await check("Импорт проверяется, объединяет по updatedAt и сохраняет равные",async()=>{
  const backup=await createBackup(db); const preview=importPreview(backup); assert(preview.notes>0&&preview.tasks>0);
  const targetName=`planner-stage5-target-${crypto.randomUUID()}`; const target=await openPlannerDatabase({name:targetName});
  await importBackup(target,backup,"replace"); const targetRepos=createRepositories(target); assert((await targetRepos.notes.getAll()).length===backup.data.notes.length);
  const current=await targetRepos.notes.get(note.id); await targetRepos.notes.put({...current,title:"Текущее"});
  await importBackup(target,backup,"merge"); assert((await targetRepos.notes.get(note.id)).title==="Текущее");
  const newer=structuredClone(backup); const incoming=newer.data.notes.find(item=>item.id===note.id); incoming.title="Новее"; incoming.updatedAt="2099-01-01T00:00:00.000Z";
  await importBackup(target,newer,"merge"); assert((await targetRepos.notes.get(note.id)).title==="Новее");
  target.close(); await deletePlannerDatabase(targetName);
});
await check("Повреждённый импорт не меняет базу",async()=>{
  const before=JSON.stringify(await createBackup(db)); let failed=false; try{parseBackup('{bad')}catch{failed=true} assert(failed);
  failed=false; try{await importBackup(db,{format:"personal-planner-backup",version:999,data:{}},"replace")}catch{failed=true} assert(failed&&JSON.stringify(await createBackup(db)).replace(/"createdAt":"[^"]+"/,"")===before.replace(/"createdAt":"[^"]+"/,""));
});
await check("Полная очистка удаляет пользовательские и служебные данные",async()=>{
  await repos.googleEventsCache.put({cacheKey:"x",calendarId:"c",start:"",updated:""}); await clearLocalData(db);
  assert((await repos.tasks.getAll()).length===0&&(await repos.notes.getAll()).length===0&&(await repos.googleEventsCache.getAll()).length===0);
});
await check("В проекте нет загрузки вложений и Blob-хранилища",async()=>{
  const html=await fetch("../index.html").then(response=>response.text()); const ui=await fetch("../js/ui.js").then(response=>response.text());
  assert(!html.includes('type="file"')); assert((ui.match(/type = "file"/g)||[]).length===1); assert(!/store[^\n]*Blob|Blob[^\n]*put\(/.test(ui));
});

db.close(); await deletePlannerDatabase(dbName);
results.forEach(result=>{const item=document.createElement("li");item.className=result.passed?"passed":"failed";item.textContent=result.passed?`Пройдено: ${result.name}`:`Ошибка: ${result.name} — ${result.error}`;list.append(item)});
const passed=results.filter(item=>item.passed).length; document.querySelector("[data-summary]").textContent=`${passed} из ${results.length} проверок пройдено`; document.documentElement.dataset.testStatus=passed===results.length?"passed":"failed"; window.__STAGE5_TEST_RESULTS__=results;
