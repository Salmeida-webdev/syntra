import { env } from "cloudflare:workers";

export type D1 = D1Database;
export type AppRole = "admin" | "company_admin" | "buyer" | "approver";
export type SessionUser = {
  id: string;
  companyId: string | null;
  name: string;
  email: string;
  role: AppRole;
  status: string;
  companyName: string | null;
  companyStatus: string | null;
  approvalRequired: number;
  segment: string | null;
};

export function db(): D1 {
  if (!env.DB) throw new Error("A conexão Cloudflare D1 ainda não está disponível.");
  return env.DB;
}

export function json(data: unknown, status = 200, extra: HeadersInit = {}) {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

export function nowIso() { return new Date().toISOString(); }
export function id(prefix = "id") { return `${prefix}_${crypto.randomUUID()}`; }
export function money(cents: number) { return Math.round(cents); }
export function normalizeEmail(value: unknown) { return String(value ?? "").trim().toLowerCase(); }
export function digits(value: unknown) { return String(value ?? "").replace(/\D/g, ""); }
export function safeText(value: unknown, max = 180) { return String(value ?? "").trim().slice(0, max); }

function toB64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function fromB64(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  return toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
export async function hashPassword(password: string, salt?: string) {
  const actualSalt = salt ?? toB64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromB64(actualSalt), iterations: 100_000, hash: "SHA-256" }, key, 256);
  return { salt: actualSalt, hash: toB64(new Uint8Array(bits)) };
}
export async function verifyPassword(password: string, salt: string, expected: string) {
  const actual = await hashPassword(password, salt);
  const left = fromB64(actual.hash);
  const right = fromB64(expected);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function cnpjIsValid(input: unknown) {
  const value = digits(input);
  if (value.length !== 14 || /^(\d)\1{13}$/.test(value)) return false;
  const calc = (base: string, weights: number[]) => {
    const sum = [...base].reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = calc(value.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calc(value.slice(0, 12) + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return value.endsWith(`${first}${second}`);
}

const products = [
  { id: "prod_papel", sku: "SYN-ESC-014", name: "Papel sulfite A4 · caixa com 10 resmas", description: "Papel branco 75 g/m² para operações de alto volume.", category: "Escritório e papelaria", image: "/images/office.webp", unit: "cx", stock: 88, min: 5, price: 24900 },
  { id: "prod_embalagem", sku: "SYN-EXP-004", name: "Kit de expedição e proteção · 50 un.", description: "Caixas, proteção kraft e acessórios para preparar pedidos em volume.", category: "Embalagens e expedição", image: "/images/packaging.webp", unit: "kit", stock: 180, min: 5, price: 32900 },
  { id: "prod_sensor", sku: "SYN-AUT-031", name: "Sensor industrial de presença · kit 4 un.", description: "Conjunto demonstrativo para automação e manutenção técnica.", category: "Equipamentos e automação", image: "/images/automation.webp", unit: "kit", stock: 64, min: 2, price: 179000 },
  { id: "prod_copos", sku: "SYN-FS-008", name: "Copos térmicos para food service · 500 un.", description: "Embalagens para cafeterias, eventos e operações de alimentação.", category: "Copa e food service", image: "/images/foodservice.webp", unit: "cx", stock: 116, min: 3, price: 39800 },
  { id: "prod_epi", sku: "SYN-EPI-017", name: "Kit EPI essencial · 10 conjuntos", description: "Proteção demonstrativa para equipes de campo e manutenção.", category: "Segurança e EPI", image: "/images/safety.webp", unit: "kit", stock: 43, min: 2, price: 126000 },
  { id: "prod_embalagem_retorno", sku: "SYN-EXP-019", name: "Caixa retornável dobrável · lote com 12", description: "Caixas resistentes para expedição recorrente e movimentação interna de produtos.", category: "Embalagens e expedição", image: "/images/returnable-packaging.webp", unit: "lote", stock: 72, min: 2, price: 184500 },
  { id: "prod_cafe", sku: "SYN-FS-024", name: "Cápsulas de café profissional · 120 un.", description: "Seleção de bebidas para salas de reunião, recepções e operações de atendimento.", category: "Copa e food service", image: "/images/coffee-service.webp", unit: "cx", stock: 95, min: 4, price: 21800 },
  { id: "prod_conectores", sku: "SYN-AUT-046", name: "Conectores industriais M12 · kit com 8", description: "Conectores e sensores para reposição programada de instalações industriais.", category: "Equipamentos e automação", image: "/images/connectors.webp", unit: "kit", stock: 51, min: 2, price: 296000 },
  { id: "prod_protecao", sku: "SYN-EPI-028", name: "Kit proteção de campo · 6 profissionais", description: "Óculos, luvas e itens de proteção para equipes técnicas e de manutenção.", category: "Segurança e EPI", image: "/images/ppe.webp", unit: "kit", stock: 38, min: 2, price: 214000 },
  { id: "prod_organizacao", sku: "SYN-ESC-027", name: "Organizadores de arquivo · conjunto com 24", description: "Conjunto para organizar documentos e padronizar estações administrativas.", category: "Escritório e papelaria", image: "/images/office-organized.webp", unit: "cj", stock: 64, min: 3, price: 14900 },
];

export async function ensureDemoData(database = db()) {
  const marker = await database.prepare("SELECT id FROM demo_seed WHERE id = 'v2'").first<{id:string}>();
  if (marker) return;
  const stamp = nowIso();
  const previousSeed = await database.prepare("SELECT id FROM demo_seed WHERE id = 'v1'").first<{id:string}>();
  if (previousSeed) {
    const addedProducts = products.filter((product) => ["prod_embalagem_retorno","prod_cafe","prod_conectores","prod_protecao","prod_organizacao"].includes(product.id));
    const upgrades: D1PreparedStatement[] = [];
    for (const p of addedProducts) {
      upgrades.push(database.prepare("INSERT OR IGNORE INTO products (id,sku,name,description,category,image_url,unit,stock,min_quantity,base_price_cents,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)").bind(p.id,p.sku,p.name,p.description,p.category,p.image,p.unit,p.stock,p.min,p.price,stamp));
      const steps = [p.min, Math.max(p.min + 5, 10), 30];
      const discounts = [0, 0.04, 0.085];
      for (const table of ["pt_distribuidor", "pt_revenda", "pt_orion"]) {
        for (let i = 0; i < steps.length; i++) {
          const segmentExtra = table === "pt_orion" ? 0.025 : table === "pt_revenda" ? -0.015 : 0;
          const factor = Math.max(0.78, 1 - discounts[i] - segmentExtra);
          upgrades.push(database.prepare("INSERT OR IGNORE INTO price_tiers (id,price_table_id,product_id,min_quantity,unit_price_cents) VALUES (?,?,?,?,?)").bind(`${table}_${p.id}_${steps[i]}`,table,p.id,steps[i],Math.round(p.price*factor)));
        }
      }
    }
    upgrades.push(database.prepare("INSERT OR IGNORE INTO demo_seed (id,seeded_at) VALUES ('v2',?)").bind(stamp));
    for (let offset = 0; offset < upgrades.length; offset += 20) await database.batch(upgrades.slice(offset, offset + 20));
    return;
  }
  const demoUsers = [
    { id: "user_admin", company: null, name: "Marina Costa", email: "admin@syntra.demo", role: "admin", status: "active" },
    { id: "user_orion_buyer", company: "co_orion", name: "Lucas Prado", email: "compras@orion.demo", role: "buyer", status: "active" },
    { id: "user_orion_approver", company: "co_orion", name: "Camila Nunes", email: "aprovadora@orion.demo", role: "approver", status: "active" },
    { id: "user_orion_admin", company: "co_orion", name: "Rafael Lima", email: "gestor@orion.demo", role: "company_admin", status: "active" },
    { id: "user_atria_buyer", company: "co_atria", name: "Bianca Reis", email: "compras@atria.demo", role: "buyer", status: "active" },
    { id: "user_pending_admin", company: "co_pending", name: "João Martins", email: "contato@novarota.demo", role: "company_admin", status: "pending" },
  ];
  const userRows = await Promise.all(demoUsers.map(async (user) => {
    const credentials = await hashPassword(crypto.randomUUID() + crypto.randomUUID());
    return { user, ...credentials };
  }));
  const commands: D1PreparedStatement[] = [];
  commands.push(
    database.prepare("INSERT OR IGNORE INTO companies (id,legal_name,trade_name,cnpj,segment,email,phone,zip,address,city,state,status,approval_required,created_at,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind("co_orion", "Orion Suprimentos Corporativos Ltda.", "Orion Suprimentos", "10293847561000", "Distribuidor regional", "financeiro@orion.demo", "(11) 4000-2026", "01310-100", "Av. Paulista, 1000 · Bela Vista", "São Paulo", "SP", "approved", 1, stamp, stamp),
    database.prepare("INSERT OR IGNORE INTO companies (id,legal_name,trade_name,cnpj,segment,email,phone,zip,address,city,state,status,approval_required,created_at,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind("co_atria", "Átria Comércio Empresarial Ltda.", "Átria Corporativo", "56473829100209", "Revenda corporativa", "compras@atria.demo", "(21) 3000-1212", "20040-020", "Rua do Ouvidor, 120 · Centro", "Rio de Janeiro", "RJ", "approved", 0, stamp, stamp),
    database.prepare("INSERT OR IGNORE INTO companies (id,legal_name,trade_name,cnpj,segment,email,phone,zip,address,city,state,status,approval_required,created_at,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind("co_pending", "Nova Rota Comércio de Materiais Ltda.", "Nova Rota Materiais", "74628395001775", "Serviços e manutenção", "contato@novarota.demo", "(31) 3555-0101", "30110-012", "Av. Afonso Pena, 800 · Centro", "Belo Horizonte", "MG", "pending", 1, stamp, null),
    database.prepare("INSERT OR IGNORE INTO price_tables (id,name,scope_type,scope_value,active,created_at) VALUES (?,?,?,?,1,?)").bind("pt_distribuidor", "Distribuidor regional · volume", "segment", "Distribuidor regional", stamp),
    database.prepare("INSERT OR IGNORE INTO price_tables (id,name,scope_type,scope_value,active,created_at) VALUES (?,?,?,?,1,?)").bind("pt_revenda", "Revenda corporativa · volume", "segment", "Revenda corporativa", stamp),
    database.prepare("INSERT OR IGNORE INTO price_tables (id,name,scope_type,scope_value,active,created_at) VALUES (?,?,?,?,1,?)").bind("pt_orion", "Acordo comercial Orion", "company", "co_orion", stamp),
  );
  for (const p of products) {
    commands.push(database.prepare("INSERT OR IGNORE INTO products (id,sku,name,description,category,image_url,unit,stock,min_quantity,base_price_cents,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)").bind(p.id,p.sku,p.name,p.description,p.category,p.image,p.unit,p.stock,p.min,p.price,stamp));
  }
  for (const p of products) {
    const steps = [p.min, Math.max(p.min + 5, 10), 30];
    const discounts = [0, 0.04, 0.085];
    for (const table of ["pt_distribuidor", "pt_revenda", "pt_orion"]) {
      for (let i = 0; i < steps.length; i++) {
        const segmentExtra = table === "pt_orion" ? 0.025 : table === "pt_revenda" ? -0.015 : 0;
        const factor = Math.max(0.78, 1 - discounts[i] - segmentExtra);
        commands.push(database.prepare("INSERT OR IGNORE INTO price_tiers (id,price_table_id,product_id,min_quantity,unit_price_cents) VALUES (?,?,?,?,?)").bind(`${table}_${p.id}_${steps[i]}`,table,p.id,steps[i],Math.round(p.price*factor)));
      }
    }
  }
  for (const row of userRows) {
    commands.push(database.prepare("INSERT OR IGNORE INTO users (id,company_id,name,email,password_salt,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(row.user.id,row.user.company,row.user.name,row.user.email,row.salt,row.hash,row.user.role,row.user.status,stamp));
  }
  // Synthetic examples seed the dashboards; stock values reflect previous confirmed demo orders.
  commands.push(
    database.prepare("INSERT OR IGNORE INTO quotes (id,company_id,user_id,number,status,subtotal_cents,discount_cents,total_cents,notes,valid_until,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind("quote_demo_1","co_orion","user_orion_buyer","COT-2026-0142","open",624000,40500,583500,"Entrega em horário comercial.",new Date(Date.now()+7*86400000).toISOString(),stamp),
    database.prepare("INSERT OR IGNORE INTO quote_items (id,quote_id,product_id,product_name,sku,quantity,unit_price_cents,list_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?,?)").bind("quote_item_demo_1","quote_demo_1","prod_papel",products[0].name,products[0].sku,20,22875,24900,457500),
    database.prepare("INSERT OR IGNORE INTO quote_items (id,quote_id,product_id,product_name,sku,quantity,unit_price_cents,list_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?,?)").bind("quote_item_demo_2","quote_demo_1","prod_epi",products[4].name,products[4].sku,1,126000,126000,126000),
    database.prepare("INSERT OR IGNORE INTO quotes (id,company_id,user_id,number,status,subtotal_cents,discount_cents,total_cents,notes,valid_until,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind("quote_demo_2","co_atria","user_atria_buyer","COT-2026-0138","open",119400,0,119400,"Cotação demonstrativa para reposição.",new Date(Date.now()+5*86400000).toISOString(),stamp),
    database.prepare("INSERT OR IGNORE INTO quote_items (id,quote_id,product_id,product_name,sku,quantity,unit_price_cents,list_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?,?)").bind("quote_item_demo_3","quote_demo_2","prod_copos",products[3].name,products[3].sku,3,39800,39800,119400),
    database.prepare("INSERT OR IGNORE INTO orders (id,company_id,user_id,quote_id,number,status,approval_note,approved_by,subtotal_cents,discount_cents,total_cents,payment_method,shipping_method,stock_reserved_at,stock_released_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind("order_demo_pending","co_orion","user_orion_buyer",null,"PED-2026-0318","awaiting_approval","Aguardando aprovação do responsável financeiro.",null,656800,80300,576500,"Faturamento demonstrativo · 28 dias","Transportadora econômica · simulado",null,null,stamp,stamp),
    database.prepare("INSERT OR IGNORE INTO order_items (id,order_id,product_id,product_name,sku,quantity,unit_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?)").bind("order_item_pending_1","order_demo_pending","prod_papel",products[0].name,products[0].sku,12,22875,274500),
    database.prepare("INSERT OR IGNORE INTO order_items (id,order_id,product_id,product_name,sku,quantity,unit_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?)").bind("order_item_pending_2","order_demo_pending","prod_sensor",products[2].name,products[2].sku,2,151000,302000),
    database.prepare("INSERT OR IGNORE INTO orders (id,company_id,user_id,quote_id,number,status,approval_note,approved_by,subtotal_cents,discount_cents,total_cents,payment_method,shipping_method,stock_reserved_at,stock_released_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind("order_demo_confirmed","co_atria","user_atria_buyer",null,"PED-2026-0312","confirmed","Pedido liberado para separação.","user_admin",318400,0,318400,"Boleto demonstrativo · 21 dias","Frete econômico · simulado",stamp,null,stamp,stamp),
    database.prepare("INSERT OR IGNORE INTO order_items (id,order_id,product_id,product_name,sku,quantity,unit_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?)").bind("order_item_confirmed_1","order_demo_confirmed","prod_copos",products[3].name,products[3].sku,8,39800,318400),
    database.prepare("INSERT OR IGNORE INTO orders (id,company_id,user_id,quote_id,number,status,approval_note,approved_by,subtotal_cents,discount_cents,total_cents,payment_method,shipping_method,stock_reserved_at,stock_released_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind("order_demo_shipped","co_orion","user_orion_buyer",null,"PED-2026-0304","shipped","Pedido enviado · código de rastreio demonstrativo.","user_orion_approver",179000,0,179000,"Faturamento demonstrativo · 28 dias","Transportadora econômica · simulado",stamp,null,stamp,stamp),
    database.prepare("INSERT OR IGNORE INTO order_items (id,order_id,product_id,product_name,sku,quantity,unit_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?)").bind("order_item_shipped_1","order_demo_shipped","prod_sensor",products[2].name,products[2].sku,1,179000,179000),
    database.prepare("INSERT OR IGNORE INTO order_events (id,order_id,actor_id,event,note,created_at) VALUES (?,?,?,?,?,?)").bind("event_pending_1","order_demo_pending","user_orion_buyer","created","Pedido enviado para aprovação.",stamp),
    database.prepare("INSERT OR IGNORE INTO order_events (id,order_id,actor_id,event,note,created_at) VALUES (?,?,?,?,?,?)").bind("event_confirmed_1","order_demo_confirmed","user_admin","confirmed","Pedido confirmado para separação.",stamp),
    database.prepare("INSERT OR IGNORE INTO order_events (id,order_id,actor_id,event,note,created_at) VALUES (?,?,?,?,?,?)").bind("event_shipped_1","order_demo_shipped","user_admin","shipped","Pedido enviado · fluxo demonstrativo.",stamp),
    database.prepare("INSERT OR IGNORE INTO demo_seed (id,seeded_at) VALUES ('v2',?)").bind(stamp),
  );
  // Keep the first-run seed below D1's practical per-batch limits. Each group
  // is idempotent, and the completion marker remains the final statement, so a
  // retry can safely continue after a partial initialization.
  const batchSize = 20;
  for (let offset = 0; offset < commands.length; offset += batchSize) {
    await database.batch(commands.slice(offset, offset + batchSize));
  }
}

export async function currentSession(request: Request, database = db()): Promise<SessionUser | null> {
  const cookie = request.headers.get("Cookie") ?? "";
  const token = cookie.split(";").map(part => part.trim()).find(part => part.startsWith("syntra_session="))?.slice("syntra_session=".length);
  if (!token) return null;
  const tokenHash = await sha256(decodeURIComponent(token));
  const session = await database.prepare(`SELECT u.id,u.company_id AS companyId,u.name,u.email,u.role,u.status,
    c.trade_name AS companyName,c.status AS companyStatus,c.approval_required AS approvalRequired,c.segment
    FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN companies c ON c.id=u.company_id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(tokenHash, nowIso()).first<SessionUser>();
  if (!session || session.status !== "active" || (session.companyId && session.companyStatus !== "approved")) return null;
  return session;
}

export function setSessionCookie(token: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `syntra_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`;
}
export function clearSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `syntra_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
export function checkSameOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin || origin === env.FRONTEND_ORIGIN;
}
