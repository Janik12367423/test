import { useState, useEffect, Component } from "react";
import CRM from "./CRM.jsx";
import { dbSet, dbGet, dbListen, isOnline } from "./firebase.js";

// ─── PERMISSIONS ──────────────────────────────────────────────────────────────
export const PERMISSIONS = {
  view_dashboard:  { label:"Главная (дашборд)",      icon:"🏠" },
  view_clients:    { label:"Просмотр клиентов",      icon:"👁️" },
  add_clients:     { label:"Добавлять клиентов",     icon:"➕" },
  edit_clients:    { label:"Редактировать клиентов", icon:"✏️" },
  delete_clients:  { label:"Удалять клиентов",       icon:"🗑️" },
  view_calculator: { label:"Расчёт КП",              icon:"🧮" },
  view_catalog:    { label:"Каталог",                icon:"📋" },
  edit_prices:     { label:"Редактировать цены",     icon:"💰" },
};

export const ROLE_PRESETS = {
  admin:        { label:"Администратор",  icon:"👑", color:"#b8965a", perms:Object.fromEntries(Object.keys(PERMISSIONS).map(k=>[k,true])) },
  manager:      { label:"Менеджер",       icon:"💼", color:"#5a9a6a", perms:{view_dashboard:true,view_clients:true,add_clients:true,edit_clients:true,delete_clients:false,view_calculator:true,view_catalog:true,edit_prices:false} },
  sales:        { label:"Продавец",       icon:"🤝", color:"#2563eb", perms:{view_dashboard:true,view_clients:true,add_clients:true,edit_clients:false,delete_clients:false,view_calculator:true,view_catalog:true,edit_prices:false} },
  readonly:     { label:"Только чтение", icon:"👀", color:"#7c3aed", perms:{view_dashboard:true,view_clients:true,add_clients:false,edit_clients:false,delete_clients:false,view_calculator:false,view_catalog:true,edit_prices:false} },
  catalog_only: { label:"Только каталог",icon:"📋", color:"#6b7280", perms:{view_dashboard:false,view_clients:false,add_clients:false,edit_clients:false,delete_clients:false,view_calculator:false,view_catalog:true,edit_prices:false} },
};

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
const AUTH_KEY="igs_auth_session", USERS_KEY="igs_auth_users", LOCKOUT_KEY="igs_auth_lockout", MAX_ATTEMPTS=5;

function simpleHash(str) {
  let h=0; for(let i=0;i<str.length;i++) h=(Math.imul(31,h)+str.charCodeAt(i))|0; return h.toString(36);
}

const DEFAULT_USERS = { zhan:{ passwordHash:simpleHash("88828822"), role:"admin", perms:ROLE_PRESETS.admin.perms } };

function getUsers() {
  try {
    const u = JSON.parse(localStorage.getItem(USERS_KEY) || "null");
    if (u && typeof u === "object") {
      // Убираем служебное поле перед возвратом
      const { __updatedAt, ...users } = u;
      return Object.keys(users).length > 0 ? users : DEFAULT_USERS;
    }
  } catch(_) {}
  localStorage.setItem(USERS_KEY, JSON.stringify(DEFAULT_USERS));
  return DEFAULT_USERS;
}
async function saveUsers(u) {
  // Добавляем метку времени последнего изменения — нужна для корректного merge
  const withTs = { ...u, __updatedAt: Date.now() };
  localStorage.setItem(USERS_KEY, JSON.stringify(withTs));
  try {
    await dbSet("users", withTs);
  } catch(e) {
    console.warn("saveUsers Firebase failed — данные в localStorage, попробуем позже");
    // Retry через 5 сек
    setTimeout(() => dbSet("users", withTs).catch(()=>{}), 5000);
  }
}
function getSession() {
  try { const s=JSON.parse(localStorage.getItem(AUTH_KEY)||"null"); if(s&&s.expires>Date.now()) return s; } catch(_){} return null;
}
function saveSession(login,role,perms) {
  const s={login,role,perms,expires:Date.now()+7*24*60*60*1000};
  localStorage.setItem(AUTH_KEY,JSON.stringify(s)); return s;
}
function clearSession() { localStorage.removeItem(AUTH_KEY); }
function getLockout() {
  try { return JSON.parse(localStorage.getItem(LOCKOUT_KEY)||"null")||{attempts:0,until:0}; } catch(_){ return {attempts:0,until:0}; }
}
function saveLockout(d) { localStorage.setItem(LOCKOUT_KEY,JSON.stringify(d)); }

export function can(session,perm) {
  if(!session) return false;
  if(session.role==="admin") return true;
  return !!(session.perms?.[perm]);
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginScreen({onLogin, users}) {
  const [login,setLogin]=useState("");
  const [password,setPassword]=useState("");
  const [showPass,setShowPass]=useState(false);
  const [error,setError]=useState("");
  const [locked,setLocked]=useState(false);
  const [lockSec,setLockSec]=useState(0);

  useEffect(()=>{ const lk=getLockout(); if(lk.until>Date.now()){setLocked(true);cd(lk.until);} },[]);

  function cd(until) {
    const tick=()=>{ const left=Math.ceil((until-Date.now())/1000); if(left<=0){setLocked(false);setLockSec(0);return;} setLockSec(left); setTimeout(tick,1000); }; tick();
  }
  function handleSubmit() {
    const lk=getLockout(); if(lk.until>Date.now()) return;
    // Используем users из props (живой state из App) + fallback на localStorage
    // Это гарантирует что LoginScreen всегда видит актуальных пользователей
    // даже если Firebase обновил список пока страница была открыта
    const currentUsers = (users && Object.keys(users).length > 0) ? users : getUsers();
    const loginKey = login.trim().toLowerCase();
    const user=currentUsers[loginKey];
    if(!user) {
      const att=(lk.attempts||0)+1;
      if(att>=MAX_ATTEMPTS){ const u=Date.now()+30*60*1000; saveLockout({attempts:att,until:u}); setLocked(true); cd(u); setError(`Превышено ${MAX_ATTEMPTS} попыток. Блокировка на 30 минут.`); }
      else { saveLockout({attempts:att,until:0}); setError(`Пользователь «${loginKey}» не найден. Осталось: ${MAX_ATTEMPTS-att}`); }
    } else if(user.passwordHash!==simpleHash(password.trim())) {
      const att=(lk.attempts||0)+1;
      if(att>=MAX_ATTEMPTS){ const u=Date.now()+30*60*1000; saveLockout({attempts:att,until:u}); setLocked(true); cd(u); setError(`Превышено ${MAX_ATTEMPTS} попыток. Блокировка на 30 минут.`); }
      else { saveLockout({attempts:att,until:0}); setError(`Неверный пароль. Осталось: ${MAX_ATTEMPTS-att}`); }
    } else {
      saveLockout({attempts:0,until:0});
      onLogin(saveSession(loginKey, user.role, user.perms||ROLE_PRESETS[user.role]?.perms||ROLE_PRESETS.manager.perms));
    }
    setPassword("");
  }
  const fmtT=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  return (
    <div style={{minHeight:"100vh",background:"#09090b",display:"flex",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"system-ui"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::selection{background:rgba(184,150,90,0.25);color:#fff;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        .li{background:#1a1a1d;border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:11px 14px;color:#eae6e1;font-size:14px;width:100%;outline:none;font-family:system-ui;transition:all 0.2s ease;}
        .li:focus{border-color:rgba(184,150,90,0.4);box-shadow:0 0 0 2px rgba(184,150,90,0.08);}
        .li::placeholder{color:rgba(255,255,255,0.2);}
        .lb{background:#b8965a;color:#09090b;border:none;border-radius:8px;padding:12px;font-weight:600;font-size:14px;cursor:pointer;font-family:system-ui;width:100%;transition:all 0.2s;letter-spacing:0.3px;}
        .lb:hover:not(:disabled){box-shadow:0 4px 20px rgba(184,150,90,0.25);}
        .lb:disabled{opacity:0.3;cursor:not-allowed;}
      `}</style>

      <div style={{width:"100%",maxWidth:360,animation:"fadeUp 0.6s cubic-bezier(0.22,1,0.36,1)"}}>
        <div style={{marginBottom:48}}>
          <div style={{fontSize:24,fontFamily:"'Instrument Serif',Georgia,serif",color:"#b8965a",marginBottom:4}}>IGS Outdoor</div>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.2)",letterSpacing:3,textTransform:"uppercase",fontWeight:500}}>Внутренняя система</div>
        </div>

        <div style={{background:"#111113",borderRadius:12,padding:"28px 24px",border:"1px solid rgba(255,255,255,0.07)"}}>
          {locked ? (
            <div style={{textAlign:"center",padding:"16px 0"}}>
              <div style={{color:"#c45454",fontWeight:600,marginBottom:8,fontSize:14}}>Доступ заблокирован</div>
              <div style={{color:"rgba(255,255,255,0.3)",fontSize:12,marginBottom:12}}>Повторите через</div>
              <div style={{color:"#b8965a",fontSize:28,fontWeight:600,fontFamily:"'IBM Plex Mono',monospace"}}>{fmtT(lockSec)}</div>
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:18}}>
              <div>
                <div style={{fontSize:10,color:"rgba(255,255,255,0.3)",marginBottom:6,fontWeight:600,letterSpacing:2,textTransform:"uppercase"}}>Логин</div>
                <input value={login} onChange={e=>{setLogin(e.target.value);setError("");}} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} placeholder="Введите логин" className="li" autoCapitalize="none" autoComplete="username"/>
              </div>
              <div>
                <div style={{fontSize:10,color:"rgba(255,255,255,0.3)",marginBottom:6,fontWeight:600,letterSpacing:2,textTransform:"uppercase"}}>Пароль</div>
                <div style={{position:"relative"}}>
                  <input type={showPass?"text":"password"} value={password} onChange={e=>{setPassword(e.target.value);setError("");}} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} placeholder="Введите пароль" className="li" autoComplete="current-password" style={{paddingRight:42}}/>
                  <button onClick={()=>setShowPass(v=>!v)} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"rgba(255,255,255,0.3)",cursor:"pointer",fontSize:13,padding:2}}>{showPass?"🙈":"👁"}</button>
                </div>
              </div>
              {error&&<div style={{fontSize:12,color:"#c45454",background:"rgba(196,84,84,0.08)",borderRadius:6,padding:"8px 12px"}}>{error}</div>}
              <button className="lb" onClick={handleSubmit} disabled={!login.trim()||!password.trim()}>Войти</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── PERM TOGGLE ─────────────────────────────────────────────────────────────
function PermToggle({permKey,value,onChange}) {
  const p=PERMISSIONS[permKey];
  return(
    <div onClick={()=>onChange(!value)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 12px",borderRadius:8,background:value?"rgba(184,150,90,0.06)":"transparent",border:`1px solid ${value?"rgba(184,150,90,0.15)":"rgba(255,255,255,0.04)"}`,cursor:"pointer",transition:"all 0.15s"}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:14}}>{p.icon}</span>
        <span style={{fontSize:12,color:value?"#eae6e1":"rgba(255,255,255,0.4)",fontFamily:"system-ui"}}>{p.label}</span>
      </div>
      <div style={{width:32,height:18,borderRadius:9,background:value?"#b8965a":"rgba(255,255,255,0.08)",position:"relative",transition:"background 0.2s",flexShrink:0}}>
        <div style={{position:"absolute",top:2,left:value?14:2,width:14,height:14,borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
      </div>
    </div>
  );
}

// ─── USER MANAGER ─────────────────────────────────────────────────────────────
function UserManager({currentUser, onClose, users, setUsers}) {
  // users и setUsers приходят из App — живой state, всегда актуальный
  // Нет нужды в локальном useState или отдельном dbListen — App уже слушает Firebase
  const [view,setView]=useState("list");
  const [editKey,setEditKey]=useState(null);
  const [newLogin,setNewLogin]=useState("");
  const [newPass,setNewPass]=useState("");
  const [selPreset,setSelPreset]=useState("manager");
  const [useCustom,setUseCustom]=useState(false);
  const [customPerms,setCustomPerms]=useState({...ROLE_PRESETS.manager.perms});
  const [msg,setMsg]=useState("");

  const inputStyle={background:"#1a1a1d",border:"1px solid rgba(255,255,255,0.07)",borderRadius:8,padding:"10px 12px",color:"#eae6e1",fontSize:13,width:"100%",outline:"none",fontFamily:"system-ui"};

  function applyPreset(pk){setSelPreset(pk);setCustomPerms({...ROLE_PRESETS[pk].perms});}
  async function addUser(){
    if(!newLogin.trim()||!newPass.trim()) return;
    const key=newLogin.trim().toLowerCase();
    if(users[key]){ setMsg(`Логин «${key}» уже занят`); setTimeout(()=>setMsg(""),3000); return; }
    const perms=useCustom?customPerms:ROLE_PRESETS[selPreset].perms;
    const role=useCustom?"manager":selPreset;
    const newUserData = {passwordHash:simpleHash(newPass.trim()),role,perms};
    const updated={...users,[key]:newUserData};
    // Обновляем App state — LoginScreen мгновенно увидит нового пользователя
    setUsers(updated);
    setMsg("Сохранение…");
    await saveUsers(updated); // пишем в localStorage + Firebase
    setNewLogin(""); setNewPass(""); setView("list");
    setMsg(`✓ Пользователь «${key}» добавлен`); setTimeout(()=>setMsg(""),3000);
  }
  async function deleteUser(key){
    if(key===currentUser.login) return;
    if(!window.confirm(`Удалить пользователя «${key}»?`)) return;
    const updated={...users}; delete updated[key];
    setUsers(updated);
    await saveUsers(updated);
  }
  function startEdit(key){ setEditKey(key); setCustomPerms({...users[key].perms}); setView("edit"); }
  async function saveEdit(){
    const role = Object.keys(ROLE_PRESETS).find(k =>
      JSON.stringify(ROLE_PRESETS[k].perms) === JSON.stringify(customPerms)
    ) || "custom";
    const updated={...users,[editKey]:{...users[editKey],perms:customPerms,role}};
    setUsers(updated);
    await saveUsers(updated);
    setView("list");
    setMsg("✓ Права сохранены"); setTimeout(()=>setMsg(""),2000);
  }

  return(
    <div style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#111113",borderRadius:16,padding:"24px",width:"100%",maxWidth:420,maxHeight:"85vh",overflowY:"auto",border:"1px solid rgba(255,255,255,0.07)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div>
            {view!=="list"&&<button onClick={()=>setView("list")} style={{background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer",fontSize:18,marginRight:8}}>←</button>}
            <span style={{fontSize:16,fontWeight:700,color:"#eae6e1",fontFamily:"system-ui"}}>{view==="list"?"Пользователи":view==="add"?"Новый пользователь":"Права: "+editKey}</span>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"rgba(255,255,255,0.3)",cursor:"pointer",fontSize:20}}>×</button>
        </div>
        {msg&&<div style={{background:"rgba(184,150,90,0.1)",border:"1px solid rgba(184,150,90,0.2)",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#b8965a",marginBottom:12}}>{msg}</div>}

        {view==="list"&&(
          <>
            <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
              {Object.entries(users).map(([key,u])=>{
                const rp=ROLE_PRESETS[u.role];
                return(
                  <div key={key} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",borderRadius:10,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <span style={{fontSize:18}}>{rp?.icon||"👤"}</span>
                      <div>
                        <div style={{fontSize:13,fontWeight:600,color:"#eae6e1",fontFamily:"system-ui"}}>{key}</div>
                        <div style={{fontSize:11,color:rp?.color||"#888",marginTop:1}}>{rp?.label||u.role}</div>
                      </div>
                    </div>
                    {key!==currentUser.login?(
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>startEdit(key)} style={{background:"rgba(184,150,90,0.08)",border:"1px solid rgba(184,150,90,0.2)",borderRadius:9,padding:"6px 12px",fontSize:11,color:"#b8965a",cursor:"pointer",fontFamily:"system-ui",fontWeight:600}}>Права</button>
                        <button onClick={()=>deleteUser(key)} style={{background:"rgba(196,84,84,0.06)",border:"1px solid rgba(196,84,84,0.15)",borderRadius:9,padding:"6px 10px",fontSize:13,color:"#c45454",cursor:"pointer"}}>🗑️</button>
                      </div>
                    ):(
                      <div style={{fontSize:10,color:"rgba(255,255,255,0.2)",background:"rgba(255,255,255,0.03)",borderRadius:7,padding:"3px 9px",fontWeight:600}}>вы</div>
                    )}
                  </div>
                );
              })}
            </div>
            <button onClick={()=>setView("add")} style={{background:"linear-gradient(135deg,#b8965a,#9a7d4a)",color:"#09090b",border:"none",borderRadius:14,padding:"14px",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"system-ui",width:"100%"}}>
              ➕ Добавить пользователя
            </button>
          </>
        )}

        {view==="add"&&(
          <div style={{display:"flex",flexDirection:"column",gap:13}}>
            <div>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.25)",marginBottom:5,fontWeight:700,letterSpacing:1}}>ЛОГИН</div>
              <input value={newLogin} onChange={e=>setNewLogin(e.target.value)} placeholder="Введите логин" style={inputStyle} autoCapitalize="none"/>
            </div>
            <div>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.25)",marginBottom:5,fontWeight:700,letterSpacing:1}}>ПАРОЛЬ</div>
              <input type="password" value={newPass} onChange={e=>setNewPass(e.target.value)} placeholder="Введите пароль" style={inputStyle}/>
            </div>
            <div>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.25)",marginBottom:8,fontWeight:700,letterSpacing:1}}>РОЛЬ</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:6}}>
                {Object.entries(ROLE_PRESETS).map(([pk,pv])=>(
                  <button key={pk} onClick={()=>{applyPreset(pk);setUseCustom(false);}} style={{background:!useCustom&&selPreset===pk?`${pv.color}12`:"rgba(255,255,255,0.02)",border:`1px solid ${!useCustom&&selPreset===pk?`${pv.color}40`:"rgba(255,255,255,0.06)"}`,borderRadius:12,padding:"12px 13px",cursor:"pointer",textAlign:"left",fontFamily:"system-ui"}}>
                    <div style={{fontSize:20,marginBottom:5}}>{pv.icon}</div>
                    <div style={{fontSize:12,fontWeight:700,color:!useCustom&&selPreset===pk?pv.color:"#eae6e1"}}>{pv.label}</div>
                  </button>
                ))}
                <button onClick={()=>setUseCustom(true)} style={{background:useCustom?"rgba(184,150,90,0.08)":"rgba(255,255,255,0.02)",border:`1px solid ${useCustom?"rgba(184,150,90,0.2)":"rgba(255,255,255,0.06)"}`,borderRadius:12,padding:"12px 13px",cursor:"pointer",textAlign:"left",fontFamily:"system-ui"}}>
                  <div style={{fontSize:20,marginBottom:5}}>⚙️</div>
                  <div style={{fontSize:12,fontWeight:700,color:useCustom?"#b8965a":"#eae6e1"}}>Вручную</div>
                </button>
              </div>
            </div>
            {useCustom&&(
              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                {Object.keys(PERMISSIONS).map(pk=>(
                  <PermToggle key={pk} permKey={pk} value={!!customPerms[pk]} onChange={v=>setCustomPerms(p=>({...p,[pk]:v}))}/>
                ))}
              </div>
            )}
            <button onClick={addUser} disabled={!newLogin.trim()||!newPass.trim()} style={{background:"linear-gradient(135deg,#b8965a,#9a7d4a)",color:"#09090b",border:"none",borderRadius:14,padding:"14px",fontWeight:700,fontSize:14,cursor:newLogin.trim()&&newPass.trim()?"pointer":"not-allowed",opacity:newLogin.trim()&&newPass.trim()?1:0.4,fontFamily:"system-ui",marginTop:4}}>
              Добавить пользователя
            </button>
          </div>
        )}

        {view==="edit"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:4}}>
              {Object.entries(ROLE_PRESETS).map(([pk,pv])=>(
                <button key={pk} onClick={()=>setCustomPerms({...pv.perms})} style={{background:`${pv.color}10`,border:`1px solid ${pv.color}30`,borderRadius:9,padding:"6px 12px",fontSize:11,fontWeight:600,color:pv.color,cursor:"pointer",fontFamily:"system-ui"}}>
                  {pv.icon} {pv.label}
                </button>
              ))}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:5}}>
              {Object.keys(PERMISSIONS).map(pk=>(
                <PermToggle key={pk} permKey={pk} value={!!customPerms[pk]} onChange={v=>setCustomPerms(p=>({...p,[pk]:v}))}/>
              ))}
            </div>
            <button onClick={saveEdit} style={{background:"linear-gradient(135deg,#b8965a,#9a7d4a)",color:"#09090b",border:"none",borderRadius:14,padding:"14px",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"system-ui",marginTop:6}}>
              💾 Сохранить права
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { console.error("App crash:", error, info); }
  render() {
    if (this.state.hasError) return (
      <div style={{minHeight:"100vh",background:"#09090b",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:14,padding:20}}>
        <div style={{fontSize:44}}>⚠️</div>
        <div style={{color:"#b8965a",fontFamily:"Georgia,serif",fontSize:20,fontWeight:800}}>IGS Outdoor CRM</div>
        <div style={{color:"rgba(255,255,255,0.5)",fontSize:13,textAlign:"center",maxWidth:400}}>Произошла ошибка. Попробуйте обновить страницу.</div>
        <button onClick={()=>window.location.reload()} style={{background:"#b8965a",color:"#09090b",border:"none",borderRadius:10,padding:"10px 24px",fontWeight:700,fontSize:14,cursor:"pointer",marginTop:8}}>Обновить</button>
        <div style={{color:"rgba(255,255,255,0.2)",fontSize:10,marginTop:8,fontFamily:"monospace",maxWidth:600,textAlign:"center"}}>{this.state.error?.message}</div>
      </div>
    );
    return this.props.children;
  }
}

export default function App() {
  const [session, setSession] = useState(()=>getSession());
  const [showUM,  setShowUM]  = useState(false);
  const [ready,   setReady]   = useState(false);
  // users живёт в state — LoginScreen и UserManager всегда видят актуальный список
  const [users,   setUsers]   = useState(getUsers());

  useEffect(()=>{
    if(window.location.pathname==="/catalog"||window.location.search.includes("catalog=1")) {
      window.location.href = "https://igs-catalog-luxury-terrasa.vercel.app";
      return;
    }

    // ── Функция применения Firebase-данных к state + localStorage ──
    function applyFbUsers(fbRaw) {
      if (!fbRaw || typeof fbRaw !== "object") return;
      const { __updatedAt: fbTs=0, ...fbUsers } = fbRaw;

      setUsers(prev => {
        // Берём всех пользователей из Firebase
        // Если у нас локально есть пользователи которых нет в Firebase
        // (добавлены офлайн) — сохраняем их тоже
        const merged = { ...fbUsers };
        Object.entries(prev).forEach(([k, v]) => {
          if (!merged[k]) merged[k] = v; // добавляем только отсутствующих
        });
        // zhan всегда должен быть
        if (!merged.zhan) merged.zhan = DEFAULT_USERS.zhan;
        // Сохраняем в localStorage
        const withTs = { ...merged, __updatedAt: Math.max(fbTs, Date.now()) };
        try { localStorage.setItem(USERS_KEY, JSON.stringify(withTs)); } catch(_) {}
        return merged;
      });
    }

    (async()=>{
      try {
        // Читаем Firebase — это источник правды для всех устройств
        const fbRaw = await dbGet("users");
        if (fbRaw && typeof fbRaw !== null) {
          applyFbUsers(fbRaw);
        } else {
          // Firebase пустой — инициализируем текущими локальными данными
          const local = getUsers();
          const withTs = { ...local, __updatedAt: Date.now() };
          await dbSet("users", withTs).catch(()=>{});
        }
      } catch(e) {
        console.warn("Users initial load failed, using localStorage:", e.message);
        // Используем что есть в localStorage — setUsers уже инициализирован
      }
      setReady(true);
    })();

    // Realtime listener — обновляет state мгновенно при любом изменении users в Firebase
    // Это ключевой момент: LoginScreen получает users как prop и сразу видит новых юзеров
    const unsub = dbListen("users", applyFbUsers);
    return unsub;
  }, []);

  function handleLogin(s) { setSession(s); }
  function handleLogout() { clearSession(); setSession(null); }

  if (!ready) return (
    <div style={{minHeight:"100vh",background:"#09090b",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:14}}>
      <div style={{fontSize:44}}>🌿</div>
      <div style={{color:"#b8965a",fontFamily:"Georgia,serif",fontSize:20,fontWeight:800}}>IGS Outdoor CRM</div>
      <div style={{color:"rgba(255,255,255,0.25)",fontSize:13}}>Подключение…</div>
    </div>
  );

  if (!session) return (
    <ErrorBoundary>
      <LoginScreen onLogin={handleLogin} users={users}/>
    </ErrorBoundary>
  );
  return (
    <>
      <CRM currentUser={session} onShowUserManager={session.role==="admin"?()=>setShowUM(true):null} onLogout={handleLogout}/>
      {showUM && <UserManager currentUser={session} onClose={()=>setShowUM(false)} users={users} setUsers={setUsers}/>}
    </>
  );
}
