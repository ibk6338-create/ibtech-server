/* ==========================================================================
   IB-TECH EPIN MANAGER — demo data layer
   Everything below is a client-side simulation stored in localStorage.
   There is no real server, payment gateway, or telecom connection — swap
   IBT.api calls for real endpoints when wiring this up to a backend.
   ========================================================================== */
const IBT = (() => {
  const DB_KEY = "ibtech_db_v1";
  const NETWORKS = ["MTN", "GLO", "AIRTEL", "9MOBILE"];
  const DENOMS = [100, 200, 500, 1000, 1500];
  const NETWORK_LOGOS = {
    MTN: "images/networks/mtn.png",
    GLO: "images/networks/glo.jpeg",
    AIRTEL: "images/networks/airtel.jpg",
    "9MOBILE": "images/networks/9mobile.jpeg"
  };
  // Three access levels. "superadmin" is the only role allowed to grant or
  // revoke admin access — this stops any admin from promoting themselves
  // or handing out access without the account owner's say-so.
  const ROLES = { USER: "user", ADMIN: "admin", SUPERADMIN: "superadmin" };

  // Flip this on once you've followed PAYMENT_SETUP.md — leave blank to keep
  // the built-in demo "instant fund" buttons (no real money involved).
  const CONFIG = {
    paystackPublicKey: "" // e.g. "pk_test_xxxxxxxxxxxxxxxxxxxxxxxx"
  };

  function pad(n, len) { return String(n).padStart(len, "0"); }

  function genPin() {
    const seg = () => pad(Math.floor(Math.random() * 10000), 4);
    return `${seg()}-${seg()}-${seg()}-${seg()}`;
  }
  function genSerial() {
    return "SN" + pad(Math.floor(Math.random() * 1e12), 12);
  }

  function seedStock(db, perDenomQty = 40) {
    NETWORKS.forEach(net => {
      db.pins[net] = db.pins[net] || {};
      DENOMS.forEach(d => {
        db.pins[net][d] = db.pins[net][d] || [];
        for (let i = 0; i < perDenomQty; i++) {
          db.pins[net][d].push({ pin: genPin(), serial: genSerial() });
        }
      });
    });
  }

  function freshDB() {
    const db = {
      users: [
        {
          id: "u_admin",
          name: "IB-TECH Admin",
          business: "IB-TECH Head Office",
          email: "admin@ibtech.com",
          phone: "08000000000",
          password: "admin123",
          role: ROLES.SUPERADMIN,
          wallet: 500000,
          createdAt: Date.now()
        },
        {
          id: "u_demo",
          name: "Ibrahim Kankia",
          business: "Kankia Recharge Stores",
          email: "demo@ibtech.com",
          phone: "08011112222",
          password: "demo1234",
          role: ROLES.USER,
          wallet: 15000,
          createdAt: Date.now()
        }
      ],
      pins: {},
      transactions: [],
      session: null
    };
    seedStock(db);
    return db;
  }

  // Keeps every user record consistent: guarantees a `role`, and mirrors it
  // onto `isAdmin` so older pages/records that only know `isAdmin` still work.
  function migrateUsers(db) {
    db.users.forEach(u => {
      if (!u.role) {
        u.role = u.isAdmin ? (u.email === "admin@ibtech.com" ? ROLES.SUPERADMIN : ROLES.ADMIN) : ROLES.USER;
      }
      u.isAdmin = u.role !== ROLES.USER;
    });
    return db;
  }

  function getDB() {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) {
      const db = freshDB();
      localStorage.setItem(DB_KEY, JSON.stringify(db));
      return db;
    }
    try { return migrateUsers(JSON.parse(raw)); } catch (e) { const db = freshDB(); saveDB(db); return db; }
  }
  function saveDB(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
  function resetDB() { localStorage.removeItem(DB_KEY); return getDB(); }

  function isSuperAdmin(user) { return !!user && user.role === ROLES.SUPERADMIN; }

  function stockCount(db, net, denom) { return (db.pins[net]?.[denom] || []).length; }

  function findUserByEmail(db, email) {
    return db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  }

  function login(email, password) {
    const db = getDB();
    const user = findUserByEmail(db, email);
    if (!user || user.password !== password) return { ok: false, error: "Incorrect email or password." };
    db.session = user.id;
    saveDB(db);
    return { ok: true, user };
  }

  function signup(data) {
    const db = getDB();
    if (findUserByEmail(db, data.email)) return { ok: false, error: "An account with that email already exists." };
    const user = {
      id: "u_" + Date.now().toString(36),
      name: data.name,
      business: data.business || "—",
      email: data.email,
      phone: data.phone || "",
      password: data.password,
      role: ROLES.USER,
      wallet: 0,
      createdAt: Date.now()
    };
    db.users.push(user);
    db.session = user.id;
    saveDB(db);
    return { ok: true, user };
  }

  function logout() {
    const db = getDB();
    db.session = null;
    saveDB(db);
  }

  function currentUser() {
    const db = getDB();
    if (!db.session) return null;
    return db.users.find(u => u.id === db.session) || null;
  }

  // Redirects if the visitor doesn't hold the right role. Call at top of protected pages.
  function requireAuth({ admin = false, loginPage = "login.html" } = {}) {
    const user = currentUser();
    if (!user) { window.location.href = loginPage; return null; }
    if (admin && !user.isAdmin) { window.location.href = "user-dashboard.html"; return null; }
    if (!admin && user.isAdmin) { window.location.href = "admin-dashboard.html"; return null; }
    return user;
  }

  function fmtNaira(n) {
    return "₦" + Number(n).toLocaleString("en-NG", { maximumFractionDigits: 0 });
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleString("en-NG", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function unitPrice(denom) {
    // Resellers buy slightly below face value — that margin is the business model.
    return Math.round(denom * 0.97);
  }

  function printCards({ network, denom, qty }) {
    const db = getDB();
    const user = currentUser();
    if (!user) return { ok: false, error: "Please log in again." };
    const available = db.pins[network]?.[denom] || [];
    if (available.length < qty) {
      return { ok: false, error: `Only ${available.length} ${network} ₦${denom} pin(s) left in stock. Try a smaller quantity or a different denomination.` };
    }
    const cost = unitPrice(denom) * qty;
    const freshUser = db.users.find(u => u.id === user.id);
    if (freshUser.wallet < cost) {
      return { ok: false, error: `Insufficient wallet balance. This batch costs ${fmtNaira(cost)}, wallet holds ${fmtNaira(freshUser.wallet)}.` };
    }
    const drawn = available.splice(0, qty);
    freshUser.wallet -= cost;
    const tx = {
      id: "tx_" + Date.now().toString(36) + Math.floor(Math.random() * 999),
      userId: user.id,
      network, denom, qty,
      cards: drawn,
      total: cost,
      date: Date.now()
    };
    db.transactions.unshift(tx);
    saveDB(db);
    return { ok: true, tx, wallet: freshUser.wallet };
  }

  function adminAddStock({ network, denom, qty }) {
    const db = getDB();
    db.pins[network] = db.pins[network] || {};
    db.pins[network][denom] = db.pins[network][denom] || [];
    for (let i = 0; i < qty; i++) db.pins[network][denom].push({ pin: genPin(), serial: genSerial() });
    saveDB(db);
    return stockCount(db, network, denom);
  }

  // Only the super admin can grant or revoke admin access. This is checked
  // again here (not just hidden in the UI) so the rule holds even if
  // someone calls IBT.setUserRole directly from the console.
  function setUserRole(actingUserId, targetUserId, newRole) {
    const db = getDB();
    const actor = db.users.find(u => u.id === actingUserId);
    const target = db.users.find(u => u.id === targetUserId);
    if (!actor || !isSuperAdmin(actor)) return { ok: false, error: "Only the super admin can change access levels." };
    if (!target) return { ok: false, error: "User not found." };
    if (target.id === actor.id) return { ok: false, error: "You can't change your own access level." };
    if (![ROLES.USER, ROLES.ADMIN, ROLES.SUPERADMIN].includes(newRole)) return { ok: false, error: "Unknown role." };
    if (target.role === ROLES.SUPERADMIN && newRole !== ROLES.SUPERADMIN) {
      const otherSuperAdmins = db.users.filter(u => u.role === ROLES.SUPERADMIN && u.id !== target.id).length;
      if (otherSuperAdmins === 0) return { ok: false, error: "At least one super admin must remain." };
    }
    target.role = newRole;
    target.isAdmin = newRole !== ROLES.USER;
    saveDB(db);
    return { ok: true, user: target };
  }

  function allUsers() {
    // Password left out of the returned copies — access-management views
    // never need it, and there's no reason to have it sitting in the DOM.
    return getDB().users.map(({ password, ...rest }) => rest);
  }

  function adminCreditWallet(userId, amount) {
    const db = getDB();
    const u = db.users.find(x => x.id === userId);
    if (!u) return { ok: false, error: "User not found." };
    u.wallet += Number(amount);
    saveDB(db);
    return { ok: true, wallet: u.wallet };
  }

  // Opens Paystack's checkout popup for a real charge. IMPORTANT: the
  // `onSuccess` callback below only fires after the *card* transaction
  // succeeds — it does not prove the money actually reached your account.
  // In production, onSuccess should call YOUR backend with the reference,
  // and your backend should call Paystack's Verify Transaction API (or
  // handle Paystack's webhook) before crediting the wallet. Crediting the
  // wallet directly from browser JS, as the demo fallback below does, is
  // only safe because there is no real money moving. See PAYMENT_SETUP.md.
  function payWithPaystack({ amount, email, onSuccess, onClose }) {
    if (!CONFIG.paystackPublicKey) {
      return { ok: false, error: "No payment gateway configured yet — see PAYMENT_SETUP.md." };
    }
    function launch() {
      const handler = window.PaystackPop.setup({
        key: CONFIG.paystackPublicKey,
        email,
        amount: Math.round(amount * 100), // Paystack expects kobo
        currency: "NGN",
        callback: (response) => onSuccess && onSuccess(response),
        onClose: () => onClose && onClose()
      });
      handler.openIframe();
    }
    if (window.PaystackPop) { launch(); return { ok: true }; }
    const script = document.createElement("script");
    script.src = "https://js.paystack.co/v1/inline.js";
    script.onload = launch;
    document.head.appendChild(script);
    return { ok: true };
  }

  function fundOwnWallet(amount) {
    const db = getDB();
    const user = currentUser();
    if (!user) return { ok: false };
    const u = db.users.find(x => x.id === user.id);
    u.wallet += Number(amount);
    saveDB(db);
    return { ok: true, wallet: u.wallet };
  }

  function allTransactions() {
    const db = getDB();
    return db.transactions.map(tx => ({
      ...tx,
      userName: db.users.find(u => u.id === tx.userId)?.name || "—"
    }));
  }

  function userTransactions(userId) {
    return allTransactions().filter(t => t.userId === userId);
  }

  function toast(msg, isError = false) {
    let el = document.getElementById("ibt-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ibt-toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle("err", isError);
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 3200);
  }

  return {
    NETWORKS, DENOMS, ROLES, CONFIG, NETWORK_LOGOS,
    getDB, saveDB, resetDB, stockCount,
    login, signup, logout, currentUser, requireAuth,
    isSuperAdmin, setUserRole, allUsers,
    fmtNaira, fmtDate, unitPrice,
    printCards, adminAddStock, adminCreditWallet, fundOwnWallet, payWithPaystack,
    allTransactions, userTransactions,
    toast
  };
})();
