import { db, currentSession, ensureDemoData, json, nowIso, id, normalizeEmail, digits, safeText, hashPassword, verifyPassword, setSessionCookie, clearSessionCookie, checkSameOrigin, cnpjIsValid } from "../lib/db";

type Ctx = { params: Promise<{ path: string[] }> };
type Company = { id:string; trade_name:string; legal_name:string; segment:string; status:string; approval_required:number };
type CartItem = { productId: string; quantity: number };
type Line = { productId:string; name:string; sku:string; quantity:number; unitPriceCents:number; listPriceCents:number; lineTotalCents:number };
const statusLabels: Record<string,string> = { draft:"Rascunho", awaiting_approval:"Aguardando aprovação", confirmed:"Confirmado", separated:"Separado", shipped:"Enviado", canceled:"Cancelado" };
const segments = ["Distribuidor regional","Revenda corporativa","Serviços e manutenção"];

function fail(message:string,status=400){ return json({error:message},status); }
function asInt(value:unknown,min=0,max=1_000_000){const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:null;}
function allowed(user:any,roles:string[]){return roles.includes(user.role);}
async function body(request:Request){try{return await request.json() as Record<string,any>}catch{return {};}}
async function priceFor(database:D1Database, product:any, company:Company|null, quantity:number){
  if(!company) return {unitPriceCents:Number(product.base_price_cents),listPriceCents:Number(product.base_price_cents),tiers:[] as any[]};
  const table=await database.prepare(`SELECT id FROM price_tables WHERE active=1 AND ((scope_type='company' AND scope_value=?) OR (scope_type='segment' AND scope_value=?)) ORDER BY CASE WHEN scope_type='company' THEN 1 ELSE 0 END DESC LIMIT 1`).bind(company.id,company.segment).first<{id:string}>();
  if(!table) return {unitPriceCents:Number(product.base_price_cents),listPriceCents:Number(product.base_price_cents),tiers:[] as any[]};
  const tier=await database.prepare("SELECT min_quantity,unit_price_cents FROM price_tiers WHERE price_table_id=? AND product_id=? AND min_quantity<=? ORDER BY min_quantity DESC LIMIT 1").bind(table.id,product.id,quantity).first<{min_quantity:number;unit_price_cents:number}>();
  const tiers=await database.prepare("SELECT min_quantity,unit_price_cents FROM price_tiers WHERE price_table_id=? AND product_id=? ORDER BY min_quantity").bind(table.id,product.id).all<{min_quantity:number;unit_price_cents:number}>();
  return {unitPriceCents:Number(tier?.unit_price_cents ?? product.base_price_cents),listPriceCents:Number(product.base_price_cents),tiers:tiers.results??[]};
}
async function companyFor(database:D1Database,companyId:string){return database.prepare("SELECT id,trade_name,legal_name,segment,status,approval_required FROM companies WHERE id=?").bind(companyId).first<Company>();}
async function getLines(database:D1Database, items:CartItem[], company:Company){
  if(!Array.isArray(items)||items.length<1||items.length>40) throw new Error("Adicione entre 1 e 40 produtos.");
  const lines:Line[]=[];
  const quantities=new Map<string,number>();
  for(const item of items){
    const quantity=asInt(item.quantity,1,10000); if(!quantity) throw new Error("Informe quantidades inteiras válidas.");
    const productId=safeText(item.productId,80);const total=(quantities.get(productId)??0)+quantity;
    if(total>10000)throw new Error("A quantidade máxima por item é 10.000 unidades.");quantities.set(productId,total);
  }
  for(const [productId,quantity] of quantities){
    const product=await database.prepare("SELECT id,name,sku,stock,min_quantity,base_price_cents,active FROM products WHERE id=?").bind(productId).first<any>();
    if(!product||Number(product.active)!==1) throw new Error("Um produto do carrinho não está disponível.");
    if(quantity<Number(product.min_quantity)) throw new Error(`${product.name}: o pedido mínimo é ${product.min_quantity} ${product.min_quantity===1?"unidade":"unidades"}.`);
    if(quantity>Number(product.stock)) throw new Error(`${product.name}: há apenas ${product.stock} unidades disponíveis no estoque demonstrativo.`);
    const pricing=await priceFor(database,product,company,quantity);
    lines.push({productId:product.id,name:product.name,sku:product.sku,quantity,unitPriceCents:pricing.unitPriceCents,listPriceCents:pricing.listPriceCents,lineTotalCents:pricing.unitPriceCents*quantity});
  }
  return lines;
}
function totals(lines:Line[]){const subtotalCents=lines.reduce((n,l)=>n+l.listPriceCents*l.quantity,0);const totalCents=lines.reduce((n,l)=>n+l.lineTotalCents,0);return {subtotalCents,discountCents:Math.max(0,subtotalCents-totalCents),totalCents};}
function number(prefix:string){return `${prefix}-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;}
async function sessionOrFail(request:Request,database:D1Database){const user=await currentSession(request,database);return user;}
async function orderItems(database:D1Database,orderId:string){const rows=await database.prepare("SELECT product_id AS productId,quantity FROM order_items WHERE order_id=?").bind(orderId).all<CartItem>();return rows.results??[];}
async function reserveStock(database:D1Database,orderId:string,actorId:string,note:string){
  const order=await database.prepare("SELECT status,company_id AS companyId FROM orders WHERE id=?").bind(orderId).first<any>();
  if(!order||!["draft","awaiting_approval"].includes(order.status)) return false;
  const items=await orderItems(database,orderId); if(!items.length) return false;
  const timestamp=nowIso();
  const orderUpdate=database.prepare(`UPDATE orders SET status='confirmed',approved_by=?,approval_note=?,stock_reserved_at=?,updated_at=?
    WHERE id=? AND status IN ('draft','awaiting_approval') AND stock_reserved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? AND p.stock<oi.quantity)`)
    .bind(actorId,note,timestamp,timestamp,orderId,orderId);
  const stockUpdates=items.map(item=>database.prepare(`UPDATE products SET stock=stock-? WHERE id=? AND EXISTS (SELECT 1 FROM orders o WHERE o.id=? AND o.status='confirmed' AND o.stock_reserved_at=?)`).bind(item.quantity,item.productId,orderId,timestamp));
  await database.batch([orderUpdate,...stockUpdates]);
  const latest=await database.prepare("SELECT status,stock_reserved_at FROM orders WHERE id=?").bind(orderId).first<any>();
  const reserved=latest?.status==="confirmed"&&latest?.stock_reserved_at===timestamp;
  if(reserved)await database.prepare("INSERT INTO order_events (id,order_id,actor_id,event,note,created_at) VALUES (?,?,?,?,?,?)").bind(id("event"),orderId,actorId,"confirmed",note,timestamp).run();
  return reserved;
}
async function createOrder(database:D1Database,user:any,company:Company,lines:Line[],quoteId:string|null,bodyData:any){
  const totalsValue=totals(lines); const orderId=id("ord"); const stamp=nowIso();
  const approvalRequired=Number(company.approval_required)===1;
  const orderStatus=approvalRequired?"awaiting_approval":"draft";
  const pay=safeText(bodyData.paymentMethod||"Faturamento demonstrativo · 28 dias",80);
  const ship=safeText(bodyData.shippingMethod||"Transportadora econômica · simulado",80);
  const validPayment=["Faturamento demonstrativo · 28 dias","Boleto demonstrativo · 21 dias","Pagamento na confirmação · simulado"].includes(pay);
  const validShipping=["Transportadora econômica · simulado","Retirada no endereço · simulado","Frete prioritário · simulado"].includes(ship);
  if(!validPayment||!validShipping) throw new Error("Selecione uma opção demonstrativa de pagamento e frete.");
  const commands:D1PreparedStatement[]=[];
  commands.push(database.prepare("INSERT INTO orders (id,company_id,user_id,quote_id,number,status,approval_note,approved_by,subtotal_cents,discount_cents,total_cents,payment_method,shipping_method,stock_reserved_at,stock_released_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(orderId,user.companyId,user.id,quoteId,number("PED"),orderStatus,approvalRequired?"Aguardando aprovação do responsável da empresa.":"",null,totalsValue.subtotalCents,totalsValue.discountCents,totalsValue.totalCents,pay,ship,null,null,stamp,stamp));
  for(const line of lines) commands.push(database.prepare("INSERT INTO order_items (id,order_id,product_id,product_name,sku,quantity,unit_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?)").bind(id("oi"),orderId,line.productId,line.name,line.sku,line.quantity,line.unitPriceCents,line.lineTotalCents));
  commands.push(database.prepare("INSERT INTO order_events (id,order_id,actor_id,event,note,created_at) VALUES (?,?,?,?,?,?)").bind(id("event"),orderId,user.id,approvalRequired?"submitted":"created",approvalRequired?"Pedido enviado para aprovação.":"Pedido criado aguardando confirmação de estoque.",stamp));
  if(quoteId) commands.push(database.prepare("UPDATE quotes SET status='converted',converted_order_id=? WHERE id=? AND company_id=? AND status='open'").bind(orderId,quoteId,user.companyId));
  await database.batch(commands);
  if(!approvalRequired){const reserved=await reserveStock(database,orderId,user.id,"Pedido confirmado automaticamente conforme a política da empresa.");if(!reserved)return {error:"O estoque mudou durante a confirmação. O pedido foi salvo como rascunho; revise as quantidades.",orderId};}
  return {orderId,approvalRequired};
}

async function handle(request:Request,context:Ctx){
  const database=db();
  await ensureDemoData(database);
  const {path=[]}=await context.params; const method=request.method.toUpperCase();
  const action=path.join("/");
  if(["POST","PATCH","PUT","DELETE"].includes(method)&&!checkSameOrigin(request))return fail("Origem da solicitação inválida.",403);

  if(action==="session"&&method==="GET"){
    const user=await sessionOrFail(request,database);return json({user});
  }
  if(action==="auth/login"&&method==="POST"){
    const data=await body(request);const email=normalizeEmail(data.email);const password=String(data.password??"");
    const user=await database.prepare("SELECT * FROM users WHERE email=?").bind(email).first<any>();
    if(!user||!(await verifyPassword(password,user.password_salt,user.password_hash)))return fail("E-mail ou senha não conferem.",401);
    if(user.status!=="active")return fail("A conta ainda aguarda liberação administrativa.",403);
    if(user.company_id){const company=await companyFor(database,user.company_id);if(!company||company.status!=="approved")return fail("A empresa ainda aguarda aprovação.",403);}
    const token=crypto.randomUUID()+crypto.randomUUID();const tokenHash=await (async()=>{const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));let b="";for(const x of new Uint8Array(bytes))b+=String.fromCharCode(x);return btoa(b).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");})();
    const expires=new Date(Date.now()+7*86400000).toISOString();
    await database.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").bind(id("sess"),user.id,tokenHash,expires,nowIso()).run();
    return json({ok:true,user:{id:user.id,name:user.name,email:user.email,role:user.role,companyId:user.company_id}},200,{"Set-Cookie":setSessionCookie(token,request)});
  }
  if(action==="auth/logout"&&method==="POST"){
    const user=await sessionOrFail(request,database);if(user){const cookie=request.headers.get("Cookie")??"";const token=cookie.split(";").map(p=>p.trim()).find(p=>p.startsWith("syntra_session="))?.slice(15);if(token){const decoded=decodeURIComponent(token);const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(decoded));let b="";for(const x of new Uint8Array(bytes))b+=String.fromCharCode(x);const h=btoa(b).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");await database.prepare("DELETE FROM sessions WHERE token_hash=?").bind(h).run();}}
    return json({ok:true},200,{"Set-Cookie":clearSessionCookie(request)});
  }
  if(action==="auth/demo"&&method==="POST"){
    const data=await body(request);const role=String(data.role??"");const emails:Record<string,string>={admin:"admin@syntra.demo",buyer:"compras@orion.demo",approver:"aprovadora@orion.demo",company_admin:"gestor@orion.demo",other_buyer:"compras@atria.demo"};
    const email=emails[role];if(!email)return fail("Perfil demonstrativo inválido.");
    const user=await database.prepare("SELECT * FROM users WHERE email=?").bind(email).first<any>();if(!user)return fail("Conta de demonstração indisponível.",503);
    const token=crypto.randomUUID()+crypto.randomUUID();const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));let b="";for(const x of new Uint8Array(bytes))b+=String.fromCharCode(x);const tokenHash=btoa(b).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
    await database.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").bind(id("sess"),user.id,tokenHash,new Date(Date.now()+7*86400000).toISOString(),nowIso()).run();
    return json({ok:true,user:{id:user.id,name:user.name,email:user.email,role:user.role,companyId:user.company_id}},200,{"Set-Cookie":setSessionCookie(token,request)});
  }
  if(action==="companies/register"&&method==="POST"){
    const data=await body(request);const legalName=safeText(data.legalName,140);const tradeName=safeText(data.tradeName,100);const cnpj=digits(data.cnpj);const email=normalizeEmail(data.email);const name=safeText(data.contactName,100);const password=String(data.password??"");const segment=safeText(data.segment,80);
    if(legalName.length<4||tradeName.length<2||!cnpjIsValid(cnpj)||!email.includes("@")||name.length<2||password.length<10||!segments.includes(segment))return fail("Confira os campos, o CNPJ e use uma senha com pelo menos 10 caracteres.");
    const exists=await database.prepare("SELECT id FROM companies WHERE cnpj=?").bind(cnpj).first();if(exists)return fail("Este CNPJ já possui cadastro.",409);
    const emailExists=await database.prepare("SELECT id FROM users WHERE email=?").bind(email).first();if(emailExists)return fail("Este e-mail já está cadastrado.",409);
    const companyId=id("co");const userId=id("user");const stamp=nowIso();const credentials=await hashPassword(password);
    await database.batch([
      database.prepare("INSERT INTO companies (id,legal_name,trade_name,cnpj,segment,email,phone,zip,address,city,state,status,approval_required,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)").bind(companyId,legalName,tradeName,cnpj,segment,email,safeText(data.phone,30),digits(data.zip),safeText(data.address,140),safeText(data.city,80),safeText(data.state,2).toUpperCase(),"pending",stamp),
      database.prepare("INSERT INTO users (id,company_id,name,email,password_salt,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)").bind(userId,companyId,name,email,credentials.salt,credentials.hash,"company_admin",stamp),
    ]);
    return json({ok:true,pending:true,message:"Cadastro recebido. A equipe Syntra revisará os dados antes de liberar as condições comerciais."},201);
  }

  const user=await sessionOrFail(request,database);if(!user)return fail("Entre no portal para continuar.",401);
  if(action==="dashboard"&&method==="GET"){
    if(user.role==="admin"){
      const [companies,orders,quotes,sales,queues,latest]=await Promise.all([
        database.prepare("SELECT status,COUNT(*) AS count FROM companies GROUP BY status").all<any>(),
        database.prepare("SELECT status,COUNT(*) AS count FROM orders GROUP BY status").all<any>(),
        database.prepare("SELECT COUNT(*) AS count FROM quotes WHERE status='open'").first<any>(),
        database.prepare("SELECT COALESCE(SUM(total_cents),0) AS cents FROM orders WHERE status IN ('confirmed','separated','shipped') AND created_at>=? ").bind(new Date(Date.now()-30*86400000).toISOString()).first<any>(),
        database.prepare("SELECT o.id,o.number,o.status,o.total_cents AS totalCents,o.created_at AS createdAt,c.trade_name AS companyName FROM orders o JOIN companies c ON c.id=o.company_id WHERE o.status='awaiting_approval' ORDER BY o.created_at DESC LIMIT 5").all<any>(),
        database.prepare("SELECT o.id,o.number,o.status,o.total_cents AS totalCents,o.created_at AS createdAt,c.trade_name AS companyName FROM orders o JOIN companies c ON c.id=o.company_id ORDER BY o.created_at DESC LIMIT 6").all<any>(),
      ]);
      return json({role:user.role,companies:companies.results??[],orders:orders.results??[],openQuotes:Number(quotes?.count??0),monthlySales:Number(sales?.cents??0),approvals:queues.results??[],latest:latest.results??[]});
    }
    const companyId=user.companyId!;
    const [orderCounts,quoteCount,spent,pending,latest]=await Promise.all([
      database.prepare("SELECT status,COUNT(*) AS count FROM orders WHERE company_id=? GROUP BY status").bind(companyId).all<any>(),
      database.prepare("SELECT COUNT(*) AS count FROM quotes WHERE company_id=? AND status='open'").bind(companyId).first<any>(),
      database.prepare("SELECT COALESCE(SUM(total_cents),0) AS cents FROM orders WHERE company_id=? AND status IN ('confirmed','separated','shipped') AND created_at>=?").bind(companyId,new Date(Date.now()-30*86400000).toISOString()).first<any>(),
      database.prepare("SELECT COUNT(*) AS count FROM orders WHERE company_id=? AND status='awaiting_approval'").bind(companyId).first<any>(),
      database.prepare("SELECT id,number,status,total_cents AS totalCents,created_at AS createdAt FROM orders WHERE company_id=? ORDER BY created_at DESC LIMIT 5").bind(companyId).all<any>(),
    ]);
    return json({role:user.role,orders:orderCounts.results??[],openQuotes:Number(quoteCount?.count??0),monthlySales:Number(spent?.cents??0),pendingApprovals:Number(pending?.count??0),latest:latest.results??[]});
  }
  if(action==="products"&&method==="GET"){
    const company=user.companyId?await companyFor(database,user.companyId):null;const rows=await database.prepare("SELECT * FROM products WHERE active=1 ORDER BY category,name").all<any>();
    const catalog=await Promise.all((rows.results??[]).map(async(p:any)=>{const pricing=await priceFor(database,p,company,Math.max(1,Number(p.min_quantity)));return {...p,stock:Number(p.stock),minQuantity:Number(p.min_quantity),basePriceCents:Number(p.base_price_cents),unitPriceCents:pricing.unitPriceCents,tiers:pricing.tiers};}));
    return json({products:catalog});
  }
  if(action==="company"&&method==="GET"){
    if(!user.companyId)return fail("Esta conta não pertence a uma empresa.",404);
    const company=await database.prepare("SELECT id,legal_name AS legalName,trade_name AS tradeName,cnpj,segment,email,phone,zip,address,city,state,status,approval_required AS approvalRequired FROM companies WHERE id=?").bind(user.companyId).first<any>();
    const members=await database.prepare("SELECT id,name,email,role,status,created_at AS createdAt FROM users WHERE company_id=? ORDER BY role,name").bind(user.companyId).all<any>();
    return json({company,members:members.results??[]});
  }
  if(action==="companies"&&method==="GET"){
    if(user.role!=="admin")return fail("Acesso restrito à administração.",403);
    const rows=await database.prepare(`SELECT c.id,c.legal_name AS legalName,c.trade_name AS tradeName,c.cnpj,c.segment,c.email,c.phone,c.city,c.state,c.status,c.approval_required AS approvalRequired,c.created_at AS createdAt,COUNT(u.id) AS usersCount FROM companies c LEFT JOIN users u ON u.company_id=c.id GROUP BY c.id ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,c.created_at DESC`).all<any>();
    return json({companies:rows.results??[]});
  }
  if(action==="orders"&&method==="GET"){
    const sql=user.role==="admin"?`SELECT o.*,o.total_cents AS totalCents,o.created_at AS createdAt,c.trade_name AS companyName,u.name AS buyerName FROM orders o JOIN companies c ON c.id=o.company_id JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 100`:`SELECT o.*,o.total_cents AS totalCents,o.created_at AS createdAt,c.trade_name AS companyName,u.name AS buyerName FROM orders o JOIN companies c ON c.id=o.company_id JOIN users u ON u.id=o.user_id WHERE o.company_id=? ORDER BY o.created_at DESC LIMIT 100`;
    const rows=user.role==="admin"?await database.prepare(sql).all<any>():await database.prepare(sql).bind(user.companyId).all<any>();
    const list=await Promise.all((rows.results??[]).map(async(o:any)=>{const items=await database.prepare("SELECT product_id AS productId,product_name AS productName,sku,quantity,unit_price_cents AS unitPriceCents,line_total_cents AS lineTotalCents FROM order_items WHERE order_id=?").bind(o.id).all<any>();return {...o,items:items.results??[]};}));
    return json({orders:list});
  }
  if(action==="quotes"&&method==="GET"){
    const sql=user.role==="admin"?`SELECT q.*,q.total_cents AS totalCents,q.created_at AS createdAt,c.trade_name AS companyName,u.name AS buyerName FROM quotes q JOIN companies c ON c.id=q.company_id JOIN users u ON u.id=q.user_id ORDER BY q.created_at DESC LIMIT 100`:`SELECT q.*,q.total_cents AS totalCents,q.created_at AS createdAt,c.trade_name AS companyName,u.name AS buyerName FROM quotes q JOIN companies c ON c.id=q.company_id JOIN users u ON u.id=q.user_id WHERE q.company_id=? ORDER BY q.created_at DESC LIMIT 100`;
    const rows=user.role==="admin"?await database.prepare(sql).all<any>():await database.prepare(sql).bind(user.companyId).all<any>();
    const list=await Promise.all((rows.results??[]).map(async(q:any)=>{const items=await database.prepare("SELECT product_id AS productId,product_name AS productName,sku,quantity,unit_price_cents AS unitPriceCents,line_total_cents AS lineTotalCents FROM quote_items WHERE quote_id=?").bind(q.id).all<any>();return {...q,items:items.results??[]};}));
    return json({quotes:list});
  }
  if(action==="price-tables"&&method==="GET"){
    if(user.role!=="admin")return fail("Acesso restrito à administração.",403);
    const tables=await database.prepare("SELECT * FROM price_tables ORDER BY scope_type,name").all<any>();
    const data=await Promise.all((tables.results??[]).map(async(t:any)=>{const tiers=await database.prepare("SELECT pt.product_id AS productId,p.name AS productName,p.sku,pt.min_quantity AS minQuantity,pt.unit_price_cents AS unitPriceCents FROM price_tiers pt JOIN products p ON p.id=pt.product_id WHERE pt.price_table_id=? ORDER BY p.name,pt.min_quantity").bind(t.id).all<any>();return {...t,tiers:tiers.results??[]};}));
    return json({priceTables:data,segments});
  }
  if(action==="company/users"&&method==="GET"){
    if(!user.companyId||!allowed(user,["company_admin","admin"]))return fail("Apenas a gestão da empresa pode administrar usuários.",403);
    const rows=await database.prepare("SELECT id,name,email,role,status,created_at AS createdAt FROM users WHERE company_id=? ORDER BY role,name").bind(user.companyId).all<any>();return json({users:rows.results??[]});
  }

  if(action==="quotes"&&method==="POST"){
    if(!user.companyId||!allowed(user,["company_admin","buyer","approver"]))return fail("Este perfil não pode solicitar cotações.",403);
    const data=await body(request);const company=await companyFor(database,user.companyId);if(!company||company.status!=="approved")return fail("Empresa sem acesso comercial.",403);
    const lines=await getLines(database,data.items,company);const total=totals(lines);const quoteId=id("quote");const stamp=nowIso();const expiry=new Date(Date.now()+7*86400000).toISOString();
    const commands:D1PreparedStatement[]=[database.prepare("INSERT INTO quotes (id,company_id,user_id,number,status,subtotal_cents,discount_cents,total_cents,notes,valid_until,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(quoteId,company.id,user.id,number("COT"),"open",total.subtotalCents,total.discountCents,total.totalCents,safeText(data.notes,500),expiry,stamp)];
    for(const line of lines)commands.push(database.prepare("INSERT INTO quote_items (id,quote_id,product_id,product_name,sku,quantity,unit_price_cents,list_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?,?)").bind(id("qi"),quoteId,line.productId,line.name,line.sku,line.quantity,line.unitPriceCents,line.listPriceCents,line.lineTotalCents));
    await database.batch(commands);return json({ok:true,quoteId,number:await database.prepare("SELECT number FROM quotes WHERE id=?").bind(quoteId).first(),...total},201);
  }
  if(action==="orders"&&method==="POST"){
    const companyId=user.companyId;if(!companyId||!allowed(user,["company_admin","buyer","approver"]))return fail("Este perfil não pode criar pedidos.",403);
    const data=await body(request);const company=await companyFor(database,companyId);if(!company||company.status!=="approved")return fail("Empresa sem acesso comercial.",403);
    let lines:Line[];let quoteId:string|null=null;
    if(data.quoteId){quoteId=safeText(data.quoteId,80);const q=await database.prepare("SELECT * FROM quotes WHERE id=? AND company_id=? AND status='open'").bind(quoteId,company.id).first<any>();if(!q)return fail("Cotação não encontrada ou já convertida.",404);const qitems=await database.prepare("SELECT product_id AS productId,quantity FROM quote_items WHERE quote_id=?").bind(quoteId).all<CartItem>();lines=await getLines(database,qitems.results??[],company);}
    else lines=await getLines(database,data.items,company);
    const created=await createOrder(database,user,company,lines,quoteId,data);if("error" in created && created.error)return fail(created.error,409);
    const order=await database.prepare("SELECT id,number,status,total_cents AS totalCents FROM orders WHERE id=?").bind(created.orderId).first<any>();
    return json({ok:true,order,approvalRequired:created.approvalRequired},201);
  }
  if(path[0]==="quotes"&&path[2]==="convert"&&method==="POST"){
    const companyId=user.companyId;if(!companyId||!allowed(user,["company_admin","buyer","approver"]))return fail("Este perfil não pode converter cotações.",403);
    const quoteId=path[1];if(!quoteId)return fail("Cotação não encontrada.",404);const q=await database.prepare("SELECT * FROM quotes WHERE id=? AND company_id=? AND status='open'").bind(quoteId,companyId).first<any>();if(!q)return fail("Cotação não encontrada ou já convertida.",404);
    const company=await companyFor(database,companyId);if(!company)return fail("Empresa não encontrada.",404);
    const qitems=await database.prepare("SELECT product_id AS productId,quantity FROM quote_items WHERE quote_id=?").bind(quoteId).all<CartItem>();const lines=await getLines(database,qitems.results??[],company);
    const created=await createOrder(database,user,company,lines,quoteId,{paymentMethod:"Faturamento demonstrativo · 28 dias",shippingMethod:"Transportadora econômica · simulado"});if("error" in created && created.error)return fail(created.error,409);
    const order=await database.prepare("SELECT id,number,status,total_cents AS totalCents FROM orders WHERE id=?").bind(created.orderId).first<any>();return json({ok:true,order,approvalRequired:created.approvalRequired},201);
  }
  if(path[0]==="orders"&&path[2]==="decision"&&method==="POST"){
    if(!user.companyId||!allowed(user,["approver","company_admin"]))return fail("Apenas um aprovador da empresa pode decidir este pedido.",403);
    const orderId=path[1];const data=await body(request);const decision=String(data.decision??"");const note=safeText(data.note,400);
    const order=await database.prepare("SELECT id,status,user_id AS userId FROM orders WHERE id=? AND company_id=?").bind(orderId,user.companyId).first<any>();if(!order)return fail("Pedido não encontrado.",404);if(order.status!=="awaiting_approval")return fail("Este pedido não aguarda aprovação.",409);if(order.userId===user.id)return fail("Outro usuário da empresa precisa decidir este pedido.",403);
    if(decision==="approve"){
      const reserved=await reserveStock(database,orderId,user.id,note||"Pedido aprovado pelo responsável da empresa.");if(!reserved)return fail("Não foi possível aprovar: revise o estoque disponível.",409);
    }else if(decision==="return"){
      const stamp=nowIso();await database.batch([
        database.prepare("UPDATE orders SET status='draft',approval_note=?,updated_at=? WHERE id=? AND company_id=? AND status='awaiting_approval'").bind(note||"Pedido devolvido para ajustes pelo aprovador.",stamp,orderId,user.companyId),
        database.prepare("INSERT INTO order_events (id,order_id,actor_id,event,note,created_at) VALUES (?,?,?,?,?,?)").bind(id("event"),orderId,user.id,"returned",note||"Pedido devolvido para ajustes.",stamp),
      ]);
    }else return fail("Escolha aprovar ou devolver o pedido.");
    return json({ok:true});
  }
  if(path[0]==="orders"&&path[1]&&path[2]==="submit"&&method==="POST"){
    if(!user.companyId||!allowed(user,["company_admin","buyer","approver"]))return fail("Este perfil não pode reenviar pedidos.",403);
    const orderId=path[1];const order=await database.prepare("SELECT id,user_id AS userId,status FROM orders WHERE id=? AND company_id=?").bind(orderId,user.companyId).first<any>();if(!order)return fail("Pedido não encontrado.",404);if(order.status!=="draft")return fail("Somente pedidos em rascunho podem ser reenviados.",409);if(order.userId!==user.id&&user.role!=="company_admin")return fail("Somente o comprador ou gestor da empresa pode reenviar este pedido.",403);
    const company=await companyFor(database,user.companyId);if(!company||company.status!=="approved")return fail("Empresa sem acesso comercial.",403);const items=await orderItems(database,orderId);const lines=await getLines(database,items,company);const sum=totals(lines);const stamp=nowIso();const approvalRequired=Number(company.approval_required)===1;
    const refreshLines:D1PreparedStatement[]=[database.prepare("UPDATE orders SET subtotal_cents=?,discount_cents=?,total_cents=?,updated_at=? WHERE id=? AND company_id=? AND status='draft'").bind(sum.subtotalCents,sum.discountCents,sum.totalCents,stamp,orderId,user.companyId)];
    for(const line of lines)refreshLines.push(database.prepare("UPDATE order_items SET unit_price_cents=?,line_total_cents=? WHERE order_id=? AND product_id=?").bind(line.unitPriceCents,line.lineTotalCents,orderId,line.productId));await database.batch(refreshLines);
    if(approvalRequired){const update=await database.prepare("UPDATE orders SET status='awaiting_approval',approval_note='Aguardando aprovação do responsável da empresa.',updated_at=? WHERE id=? AND company_id=? AND status='draft'").bind(stamp,orderId,user.companyId).run();if(!update.meta.changes)return fail("O pedido mudou de estado. Atualize a página.",409);await database.prepare("INSERT INTO order_events (id,order_id,actor_id,event,note,created_at) VALUES (?,?,?,?,?,?)").bind(id("event"),orderId,user.id,"resubmitted","Pedido reenviado para aprovação.",stamp).run();}
    else {const reserved=await reserveStock(database,orderId,user.id,"Pedido confirmado após reenvio conforme a política da empresa.");if(!reserved)return fail("Não foi possível confirmar: confira o estoque disponível.",409);}
    return json({ok:true,approvalRequired});
  }
  if(path[0]==="company"&&path[1]==="settings"&&method==="PATCH"){
    if(!user.companyId||!allowed(user,["company_admin"]))return fail("Apenas o administrador da empresa pode alterar esta configuração.",403);
    const data=await body(request);const approvalRequired=data.approvalRequired?1:0;await database.prepare("UPDATE companies SET approval_required=? WHERE id=?").bind(approvalRequired,user.companyId).run();return json({ok:true,approvalRequired});
  }
  if(action==="company/users"&&method==="POST"){
    if(!user.companyId||user.role!=="company_admin")return fail("Apenas o administrador da empresa pode adicionar usuários.",403);
    const data=await body(request);const name=safeText(data.name,100);const email=normalizeEmail(data.email);const role=String(data.role??"");const password=String(data.password??"");
    if(name.length<2||!email.includes("@")||! ["buyer","approver"].includes(role)||password.length<10)return fail("Preencha nome, e-mail, perfil e senha com pelo menos 10 caracteres.");
    const exists=await database.prepare("SELECT id FROM users WHERE email=?").bind(email).first();if(exists)return fail("Este e-mail já está cadastrado.",409);
    const credentials=await hashPassword(password);await database.prepare("INSERT INTO users (id,company_id,name,email,password_salt,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id("user"),user.companyId,name,email,credentials.salt,credentials.hash,role,"active",nowIso()).run();return json({ok:true},201);
  }

  if(path[0]==="companies"&&path[2]==="status"&&method==="PATCH"){
    if(user.role!=="admin")return fail("Acesso restrito à administração.",403);
    const companyId=path[1];const data=await body(request);const status=String(data.status??"");if(!["approved","rejected"].includes(status))return fail("Estado de cadastro inválido.");const stamp=nowIso();
    await database.batch([
      database.prepare("UPDATE companies SET status=?,approved_at=? WHERE id=?").bind(status,status==="approved"?stamp:null,companyId),
      database.prepare("UPDATE users SET status=? WHERE company_id=? AND status IN ('pending','active')").bind(status==="approved"?"active":"disabled",companyId),
    ]);return json({ok:true});
  }
  if(action==="products"&&method==="POST"){
    if(user.role!=="admin")return fail("Acesso restrito à administração.",403);const data=await body(request);
    const name=safeText(data.name,120);const sku=safeText(data.sku,40).toUpperCase();const category=safeText(data.category,80);const price=asInt(data.basePriceCents,1,100_000_000);const stock=asInt(data.stock,0,1_000_000);const min=asInt(data.minQuantity,1,10000);const imageUrl=safeText(data.imageUrl,180);
    if(name.length<3||sku.length<3||!category||!price||stock===null||!min||!imageUrl.startsWith("/images/"))return fail("Confira nome, SKU, categoria, preço, estoque e imagem.");
    await database.prepare("INSERT INTO products (id,sku,name,description,category,image_url,unit,stock,min_quantity,base_price_cents,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)").bind(id("prod"),sku,name,safeText(data.description,250),category,imageUrl,safeText(data.unit||"un",12),stock,min,price,nowIso()).run();return json({ok:true},201);
  }
  if(path[0]==="products"&&path[1]&&method==="PATCH"){
    if(user.role!=="admin")return fail("Acesso restrito à administração.",403);const data=await body(request);const name=safeText(data.name,120);const price=asInt(data.basePriceCents,1,100_000_000);const stock=asInt(data.stock,0,1_000_000);const min=asInt(data.minQuantity,1,10000);const imageUrl=safeText(data.imageUrl,180);if(name.length<3||!price||stock===null||!min||!imageUrl.startsWith("/images/"))return fail("Confira os dados do produto.");
    await database.prepare("UPDATE products SET name=?,description=?,category=?,image_url=?,unit=?,stock=?,min_quantity=?,base_price_cents=?,active=? WHERE id=?").bind(name,safeText(data.description,250),safeText(data.category,80),imageUrl,safeText(data.unit||"un",12),stock,min,price,data.active===false?0:1,path[1]).run();return json({ok:true});
  }
  if(path[0]==="products"&&path[1]&&path[2]==="stock"&&method==="POST"){
    if(user.role!=="admin")return fail("Acesso restrito à administração.",403);const data=await body(request);const amount=asInt(data.amount,1,100000);const direction=String(data.direction);if(!amount||!["add","set"].includes(direction))return fail("Informe uma quantidade válida.");if(direction==="set")await database.prepare("UPDATE products SET stock=? WHERE id=?").bind(amount,path[1]).run();else await database.prepare("UPDATE products SET stock=stock+? WHERE id=?").bind(amount,path[1]).run();return json({ok:true});
  }
  if(action==="price-tables"&&method==="POST"){
    if(user.role!=="admin")return fail("Acesso restrito à administração.",403);const data=await body(request);const name=safeText(data.name,100);const scopeType=String(data.scopeType);const scopeValue=safeText(data.scopeValue,100);const tiers=Array.isArray(data.tiers)?data.tiers:[];
    if(name.length<3||!["company","segment"].includes(scopeType)||!scopeValue||tiers.length>500)return fail("Defina nome, escopo e condições de preço.");if(scopeType==="segment"&&!segments.includes(scopeValue))return fail("Segmento não reconhecido.");
    const tableId=id("pt");const stamp=nowIso();await database.prepare("INSERT INTO price_tables (id,name,scope_type,scope_value,active,created_at) VALUES (?,?,?,?,1,?)").bind(tableId,name,scopeType,scopeValue,stamp).run();
    const commands:D1PreparedStatement[]=[];for(const t of tiers){const productId=safeText(t.productId,80);const min=asInt(t.minQuantity,1,10000);const price=asInt(t.unitPriceCents,1,100_000_000);if(min&&price)commands.push(database.prepare("INSERT OR REPLACE INTO price_tiers (id,price_table_id,product_id,min_quantity,unit_price_cents) VALUES (?,?,?,?,?)").bind(id("tier"),tableId,productId,min,price));}if(commands.length)await database.batch(commands);return json({ok:true,tableId},201);
  }
  if(path[0]==="price-tables"&&path[1]&&method==="PUT"){
    if(user.role!=="admin")return fail("Acesso restrito à administração.",403);const data=await body(request);const name=safeText(data.name,100);const tiers=Array.isArray(data.tiers)?data.tiers:[];if(name.length<3||tiers.length>500)return fail("Confira a tabela e as condições.");
    const commands:D1PreparedStatement[]=[database.prepare("UPDATE price_tables SET name=?,active=? WHERE id=?").bind(name,data.active===false?0:1,path[1]),database.prepare("DELETE FROM price_tiers WHERE price_table_id=?").bind(path[1])];
    for(const t of tiers){const productId=safeText(t.productId,80);const min=asInt(t.minQuantity,1,10000);const price=asInt(t.unitPriceCents,1,100_000_000);if(min&&price)commands.push(database.prepare("INSERT INTO price_tiers (id,price_table_id,product_id,min_quantity,unit_price_cents) VALUES (?,?,?,?,?)").bind(id("tier"),path[1],productId,min,price));}await database.batch(commands);return json({ok:true});
  }
  if(path[0]==="orders"&&path[1]&&path[2]==="status"&&method==="PATCH"){
    if(user.role!=="admin")return fail("Apenas a administração pode alterar o estado logístico.",403);const orderId=path[1];const data=await body(request);const next=String(data.status??"");const existing=await database.prepare("SELECT status,stock_reserved_at,stock_released_at FROM orders WHERE id=?").bind(orderId).first<any>();if(!existing)return fail("Pedido não encontrado.",404);
    const transitions:Record<string,string[]>={confirmed:["separated","canceled"],separated:["shipped","canceled"]};if(!transitions[existing.status]?.includes(next))return fail("Esta transição de pedido não é permitida.",409);const stamp=nowIso();
    if(next==="canceled"&&existing.stock_reserved_at&&!existing.stock_released_at){const items=await orderItems(database,orderId);const commands:D1PreparedStatement[]=[database.prepare("UPDATE orders SET status='canceled',stock_released_at=?,updated_at=? WHERE id=? AND status=? AND stock_released_at IS NULL").bind(stamp,stamp,orderId,existing.status)];for(const item of items)commands.push(database.prepare("UPDATE products SET stock=stock+? WHERE id=? AND EXISTS (SELECT 1 FROM orders o WHERE o.id=? AND o.status='canceled' AND o.stock_released_at=?)").bind(item.quantity,item.productId,orderId,stamp));commands.push(database.prepare("INSERT INTO order_events (id,order_id,actor_id,event,note,created_at) VALUES (?,?,?,?,?,?)").bind(id("event"),orderId,user.id,"canceled",safeText(data.note,300)||"Pedido cancelado pela administração.",stamp));await database.batch(commands);}
    else await database.batch([database.prepare("UPDATE orders SET status=?,updated_at=? WHERE id=? AND status=?").bind(next,stamp,orderId,existing.status),database.prepare("INSERT INTO order_events (id,order_id,actor_id,event,note,created_at) VALUES (?,?,?,?,?,?)").bind(id("event"),orderId,user.id,next,safeText(data.note,300)||statusLabels[next],stamp)]);
    return json({ok:true});
  }
  if(action==="order-events"&&method==="GET"){
    const orderId=new URL(request.url).searchParams.get("orderId");if(!orderId)return fail("Informe o pedido.");const order=await database.prepare("SELECT company_id AS companyId FROM orders WHERE id=?").bind(orderId).first<any>();if(!order||user.role!=="admin"&&order.companyId!==user.companyId)return fail("Pedido não encontrado.",404);const events=await database.prepare("SELECT e.event,e.note,e.created_at AS createdAt,u.name AS actor FROM order_events e JOIN users u ON u.id=e.actor_id WHERE e.order_id=? ORDER BY e.created_at").bind(orderId).all<any>();return json({events:events.results??[]});
  }
  return fail("Rota não encontrada.",404);
}

async function wrapped(request:Request,context:Ctx){
  try{return await handle(request,context)}catch(error){
    const message=error instanceof Error?error.message:"Não foi possível concluir a operação.";
    console.error("Syntra request failed", message);
    if(message.includes("no such table"))return fail("O banco de demonstração ainda está iniciando. Atualize a página em alguns segundos.",503);
    return fail(message,400);
  }
}
export const GET=wrapped;
export const POST=wrapped;
export const PATCH=wrapped;
export const PUT=wrapped;
