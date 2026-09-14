/* IB-TECH ePINs front-end API client */
const IBT = (() => {
  const CONFIG = {
    // Same-origin API: Railway's web gateway proxies /api/* to the Node backend.
    apiBase: window.IBT_API_BASE || "",
    paystackPublicKey: ""
  };
  const NETWORKS = ["MTN", "GLO", "AIRTEL", "9MOBILE"];
  const DENOMS = [100, 200, 500, 1000, 1500];
  const ROLES = { USER: "user", ADMIN: "admin", SUPERADMIN: "superadmin" };
  const NETWORK_LOGOS = {
    MTN: "images/networks/mtn.png", GLO: "images/networks/glo.jpeg",
    AIRTEL: "images/networks/airtel.jpg", "9MOBILE": "images/networks/9mobile.jpeg"
  };
  const TOKEN_KEY = "ibtech_token", USER_KEY = "ibtech_user", REMEMBER_KEY = "ibtech_remember_identifier";
  function rememberIdentifier(v){localStorage.setItem(REMEMBER_KEY,v)}
  function forgetIdentifier(){localStorage.removeItem(REMEMBER_KEY)}
  function getRememberedIdentifier(){return localStorage.getItem(REMEMBER_KEY)||""}
  function getToken(){return sessionStorage.getItem(TOKEN_KEY)}
  function setSession(token,user){sessionStorage.setItem(TOKEN_KEY,token);sessionStorage.setItem(USER_KEY,JSON.stringify(user))}
  function clearSession(){sessionStorage.removeItem(TOKEN_KEY);sessionStorage.removeItem(USER_KEY)}
  function cachedUser(){try{return JSON.parse(sessionStorage.getItem(USER_KEY))}catch{return null}}
  async function request(method,path,body,{auth=true}={}){
    const headers={"Content-Type":"application/json"}; const t=getToken(); if(auth&&t)headers.Authorization="Bearer "+t;
    try{const res=await fetch(CONFIG.apiBase+path,{method,headers,body:body!==undefined?JSON.stringify(body):undefined});const data=await res.json().catch(()=>({}));if(data.ok===undefined)return{ok:false,error:`Unexpected response (${res.status}).`};return data}
    catch(e){return{ok:false,error:"Could not reach the IB-TECH server. Please try again."}}
  }
  async function login(identifier,password){const r=await request("POST","/api/auth/login",{identifier,password},{auth:false});if(r.ok)setSession(r.token,r.user);return r}
  async function forgotPassword(identifier){return request("POST","/api/auth/forgot",{identifier},{auth:false})}
  async function resetPassword(token,password){return request("POST","/api/auth/reset",{token,password},{auth:false})}
  async function signup(data){const r=await request("POST","/api/auth/signup",data,{auth:false});if(r.ok)setSession(r.token,r.user);return r}
  async function logout(){await request("POST","/api/auth/logout",{});clearSession()}
  async function requireAuth({admin=false,loginPage="login.html"}={}){if(!getToken()){window.location.href=loginPage;return null}const r=await request("GET","/api/me");if(!r.ok){clearSession();window.location.href=loginPage;return null}const user=r.user;sessionStorage.setItem(USER_KEY,JSON.stringify(user));const isAdmin=user.role!==ROLES.USER;if(admin&&!isAdmin){window.location.href="user-dashboard.html";return null}if(!admin&&isAdmin){window.location.href="admin-dashboard.html";return null}return user}
  function isSuperAdmin(user){return!!user&&user.role===ROLES.SUPERADMIN}
  async function updateAvatar(dataUrl){const r=await request("POST","/api/me/avatar",{image:dataUrl});if(r.ok){const u=cachedUser();if(u){u.avatar=r.avatar;sessionStorage.setItem(USER_KEY,JSON.stringify(u))}}return r}
  async function getStock(){const r=await request("GET","/api/stock",undefined,{auth:false});return r.ok?r.stock:{}}
  function stockCount(stock,net,denom){return stock?.[net]?.[denom]||0}
  async function printCards({network,denom,qty}){const r=await request("POST","/api/print",{network,denom,qty});if(r.ok){const u=cachedUser();if(u){u.wallet=r.wallet;sessionStorage.setItem(USER_KEY,JSON.stringify(u))}}return r}
  async function myTransactions(){const r=await request("GET","/api/transactions");return r.ok?r.transactions:[]}
  async function allTransactions(){const r=await request("GET","/api/transactions?all=1");return r.ok?r.transactions:[]}
  async function deleteTransaction(id){return request("POST","/api/transactions/delete",{id})}
  async function walletInitiate(amount){return request("POST","/api/wallet/initiate",{amount})}
  async function walletVerify(reference){const r=await request("POST","/api/wallet/verify",{reference});if(r.ok){const u=cachedUser();if(u){u.wallet=r.wallet;sessionStorage.setItem(USER_KEY,JSON.stringify(u))}}return r}
  function loadPaystackScript(){return new Promise(resolve=>{if(window.PaystackPop)return resolve();const s=document.createElement("script");s.src="https://js.paystack.co/v1/inline.js";s.onload=resolve;document.head.appendChild(s)})}
  async function payWithPaystack({amount,onSuccess,onClose,onError}){if(!CONFIG.paystackPublicKey){const e="No Paystack public key configured yet.";onError&&onError(e);return{ok:false,error:e}}const init=await walletInitiate(amount);if(!init.ok){onError&&onError(init.error);return init}await loadPaystackScript();const user=cachedUser();const handler=window.PaystackPop.setup({key:CONFIG.paystackPublicKey,email:user?.email,amount:Math.round(amount*100),ref:init.reference,callback:async()=>{const v=await walletVerify(init.reference);if(v.ok)onSuccess&&onSuccess(v);else onError&&onError(v.error)},onClose:()=>onClose&&onClose()});handler.openIframe();return{ok:true}}
  async function adminAddStock({network,denom,qty}){return request("POST","/api/admin/stock",{network,denom,qty})}
  async function adminCreditWallet(userId,amount){return request("POST","/api/admin/credit",{userId,amount})}
  async function adminRefund(userId,amount,reason){return request("POST","/api/admin/refund",{userId,amount,reason})}
  async function adminUsers(){const r=await request("GET","/api/admin/users");return r.ok?r.users:[]}
  async function setUserRole(targetUserId,role){return request("POST","/api/admin/access",{userId:targetUserId,role})}
  async function adminPayout({userId,amount,accountNumber,bankCode,accountName}){return request("POST","/api/admin/payout",{userId,amount,accountNumber,bankCode,accountName})}
  function fmtNaira(n){return"₦"+Number(n).toLocaleString("en-NG",{maximumFractionDigits:0})}
  function fmtDate(ts){return new Date(ts).toLocaleString("en-NG",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}
  function unitPrice(denom){return Math.round(denom*.97)}
  function toast(msg,isError=false){let el=document.getElementById("ibt-toast");if(!el){el=document.createElement("div");el.id="ibt-toast";el.className="toast";document.body.appendChild(el)}el.textContent=msg;el.classList.toggle("err",isError);el.classList.add("show");clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove("show"),3200)}
  return {CONFIG,NETWORKS,DENOMS,ROLES,NETWORK_LOGOS,login,signup,logout,requireAuth,cachedUser,isSuperAdmin,forgotPassword,resetPassword,updateAvatar,rememberIdentifier,forgetIdentifier,getRememberedIdentifier,getStock,stockCount,printCards,myTransactions,allTransactions,deleteTransaction,walletInitiate,walletVerify,payWithPaystack,adminAddStock,adminCreditWallet,adminRefund,adminUsers,setUserRole,adminPayout,fmtNaira,fmtDate,unitPrice,toast};
})();