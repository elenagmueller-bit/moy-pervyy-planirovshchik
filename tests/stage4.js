import { deletePlannerDatabase, openPlannerDatabase } from "../js/db.js";
import { createRepositories } from "../js/repositories.js";
import { createSeriesRecord, generateOccurrenceDates, previewSeries } from "../js/recurrence.js";

const results=[]; const list=document.querySelector("[data-results]");
const assert=(value,message="Проверка не пройдена")=>{if(!value) throw new Error(message)};
async function check(name,operation){try{await operation();results.push({name,passed:true})}catch(error){results.push({name,passed:false,error:`${error.message}${error.errors?` ${JSON.stringify(error.errors)}`:""}`})}}
const base=(overrides={})=>({title:"Оплатить интернет",shortDescription:"",details:"",date:"2024-01-31",hasTime:true,startTime:"10:00",durationMinutes:15,priority:"medium",category:"personal",status:"active",tags:[],links:[],checklist:[],recurrence:{frequency:"daily",endType:"never"},...overrides});
const dates=(recurrence,start="2024-01-01",end="2030-12-31")=>generateOccurrenceDates(createSeriesRecord(base({date:start,recurrence}),new Date("2024-01-01T00:00:00Z")),start,end);

await check("Все стандартные частоты",()=>{
  assert(dates({frequency:"daily",endType:"count",count:3}).join()==="2024-01-01,2024-01-02,2024-01-03");
  assert(dates({frequency:"weekly",endType:"count",count:3}).join()==="2024-01-01,2024-01-08,2024-01-15");
  assert(dates({frequency:"weekdays",weekdays:[1,3],endType:"count",count:4}).join()==="2024-01-01,2024-01-03,2024-01-08,2024-01-10");
  assert(dates({frequency:"monthly",endType:"count",count:3}).join()==="2024-01-01,2024-02-01,2024-03-01");
  assert(dates({frequency:"yearly",endType:"count",count:2}).join()==="2024-01-01,2025-01-01");
});
await check("Пользовательские интервалы",()=>{
  for(const [unit,expected] of [["days","2024-01-05"],["weeks","2024-01-29"],["months","2024-05-01"],["years","2028-01-01"]]) assert(dates({frequency:"custom",interval:4,intervalUnit:unit,endType:"count",count:2})[1]===expected,unit);
});
await check("Короткие месяцы и високосный год",()=>{
  assert(previewSeries({frequency:"monthly",endType:"never"},"2023-01-31",4).join()==="2023-01-31,2023-02-28,2023-03-31,2023-04-30");
  assert(previewSeries({frequency:"monthly",endType:"never"},"2024-01-30",3).join()==="2024-01-30,2024-02-29,2024-03-30");
  assert(previewSeries({frequency:"monthly",endType:"never"},"2024-01-29",3).join()==="2024-01-29,2024-02-29,2024-03-29");
  assert(previewSeries({frequency:"yearly",endType:"never"},"2024-02-29",5).at(-1)==="2028-02-29");
});
await check("Окончание по дате и количеству включительно",()=>{
  assert(dates({frequency:"daily",endType:"date",until:"2024-01-03"}).length===3);
  assert(dates({frequency:"daily",endType:"count",count:2}).length===2);
});
await check("Генерируется только запрошенный диапазон",()=>{
  const started=performance.now(); const actual=dates({frequency:"daily",endType:"never"},"2024-01-01","2024-01-07");
  assert(actual.length===7); assert(performance.now()-started<100,"Слишком медленно");
});

const dbName=`planner-stage4-${crypto.randomUUID()}`; const db=await openPlannerDatabase({name:dbName}); const repos=createRepositories(db);
let created; let second;
await check("Экземпляры вычисляются, а не сохраняются",async()=>{
  created=await repos.recurrence.createFromTask(base({date:"2024-01-01",recurrence:{frequency:"weekly",endType:"count",count:5}}));
  const visible=await repos.recurrence.listRange("2024-01-01","2024-02-29");
  assert(visible.length===5 && visible.every(item=>item.isVirtual));
  const stored=await repos.tasks.getAll(); assert(stored.length===0);
  second=visible[1];
});
await check("Завершение одного не сдвигает следующий",async()=>{
  await repos.recurrence.completeOccurrence(second,new Date("2024-01-08T10:00:00Z"));
  const visible=await repos.recurrence.listRange("2024-01-01","2024-02-29");
  assert(visible.find(item=>item.recurrenceId==="2024-01-08").status==="completed");
  assert(visible.find(item=>item.recurrenceId==="2024-01-15").date==="2024-01-15");
});
await check("Перенос только одного создаёт исключение",async()=>{
  const third=(await repos.recurrence.listRange("2024-01-01","2024-02-29")).find(item=>item.recurrenceId==="2024-01-15");
  await repos.recurrence.changeOccurrence(third,{date:"2024-01-16"},"instance");
  const visible=await repos.recurrence.listRange("2024-01-01","2024-02-29");
  assert(visible.some(item=>item.recurrenceId==="2024-01-15"&&item.date==="2024-01-16"));
  assert(visible.some(item=>item.recurrenceId==="2024-01-22"&&item.date==="2024-01-22"));
});
await check("Области: один, будущие, вся серия",async()=>{
  const fourth=(await repos.recurrence.listRange("2024-01-01","2024-02-29")).find(item=>item.recurrenceId==="2024-01-22");
  await repos.recurrence.changeOccurrence(fourth,{title:"Новый этап"},"future");
  const storedSeries=await repos.series.getAll(); assert(storedSeries.length===2 && storedSeries.some(item=>item.splitFromSeriesId===created.id));
  const future=(await repos.recurrence.listRange("2024-01-01","2024-02-29")).find(item=>item.date==="2024-01-29"); assert(future.title==="Новый этап");
  await repos.recurrence.changeOccurrence(future,{priority:"high"},"series");
  const again=await repos.recurrence.listRange("2024-01-01","2024-02-29"); assert(again.find(item=>item.date==="2024-01-29").priority==="high");
});
await check("Отмена и удаление поддерживают три области",async()=>{
  for(const action of ["cancel","trash"]) for(const scope of ["instance","future","series"]){
    const series=await repos.recurrence.createFromTask(base({title:`${action}-${scope}`,date:"2025-01-01",recurrence:{frequency:"daily",endType:"count",count:4}}));
    const occurrence=(await repos.recurrence.listRange("2025-01-01","2025-01-05")).filter(item=>item.seriesId===series.id)[1];
    const changed=await repos.recurrence.lifecycleOccurrence(occurrence,action,scope);
    assert(action==="cancel"?changed.status==="cancelled"&&Boolean(changed.archivedAt):Boolean(changed.trashedAt),`${action}-${scope}`);
    if(scope==="instance") assert((await repos.tasks.getAll()).some(item=>item.seriesId===series.id&&item.recurrenceId===occurrence.recurrenceId));
    if(scope==="future") assert((await repos.series.getAll()).some(item=>item.splitFromSeriesId===series.id));
    if(scope==="series") assert(Boolean(await repos.recurrence.getSeries(series.id)));
  }
});
await check("Локальные дата и настенное время не преобразуются",async()=>{
  const item=(await repos.recurrence.listRange("2024-01-01","2024-02-29"))[0]; assert(/^2024-/.test(item.date)); assert(item.startTime==="10:00");
});

db.close(); await deletePlannerDatabase(dbName);
results.forEach(result=>{const item=document.createElement("li");item.className=result.passed?"passed":"failed";item.textContent=result.passed?`Пройдено: ${result.name}`:`Ошибка: ${result.name} — ${result.error}`;list.append(item)});
const passed=results.filter(item=>item.passed).length; document.querySelector("[data-summary]").textContent=`${passed} из ${results.length} проверок пройдено`; document.documentElement.dataset.testStatus=passed===results.length?"passed":"failed"; window.__STAGE4_TEST_RESULTS__=results;
