import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(express.json());

// --- DB ---
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
});

// --- Mail (optional) ---
function mailEnabled() {
  return (
    !!process.env.SMTP_HOST &&
    !!process.env.SMTP_USER &&
    !!process.env.SMTP_PASS &&
    !!process.env.WITHDRAW_NOTIFY_TO
  );
}

function getTransport() {
  const port = Number(process.env.SMTP_PORT || "465");
  const secure =
    String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendWithdrawEmail({ to, from, subject, html, text }) {
  if (!mailEnabled()) return { sent: false, reason: "mail_not_configured" };
  const transporter = getTransport();
  await transporter.sendMail({ to, from, subject, html, text });
  return { sent: true };
}

function nowBogotaISO() {
  // Railway corre en UTC; dejamos ISO y también un string legible.
  const d = new Date();
  return d.toISOString();
}

function formatMoneyMXN(n) {
  try {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
      maximumFractionDigits: 0,
    }).format(Number(n || 0));
  } catch {
    return `$${Number(n || 0).toLocaleString("en-US")}`;
  }
}

// --- Health ---
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

// --- Login ---
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const [rows] = await pool.query(
    "SELECT id, email, name FROM users WHERE email=? AND password=? LIMIT 1",
    [email, password]
  );

  if (!rows.length) {
    return res.status(401).json({ message: "Credenciales inválidas" });
  }

  res.json({ user: rows[0] });
});

// --- Productos del usuario (dashboard) ---
app.get("/dashboard/:userId", async (req, res) => {
  const { userId } = req.params;

  // saldo real = sum(transactions.amount)
  const [[bal]] = await pool.query(
    `
    SELECT COALESCE(SUM(amount),0) AS balance
    FROM transactions
    WHERE user_id=?
    `,
    [userId]
  );

  const [products] = await pool.query(
    `
    SELECT 
      p.id, p.name, p.subtitle, p.term, p.rate, p.status,
      up.invested_amount AS invested,
      up.maturity_date AS maturity,
      up.start_date AS startDate,
      up.term_months AS termMonths,
      up.annual_rate AS annualRate,
      up.no_withdraw_bonus AS noWithdrawBonus,
      up.period_rate AS periodRate,
      up.contract_number AS contractNumber,
      up.country AS country,
      up.indicated_payment AS indicatedPayment,
      up.currency AS currency
    FROM user_products up
    JOIN products p ON p.id = up.product_id
    WHERE up.user_id=?
    ORDER BY up.id ASC
    `,
    [userId]
  );

  const [txns] = await pool.query(
    `
    SELECT 
      id, type, description, reference, status, amount, txn_date AS date, product_id AS productId
    FROM transactions
    WHERE user_id=?
    ORDER BY txn_date DESC, id DESC
    LIMIT 50
    `,
    [userId]
  );

  // rendimiento estimado: suma de yields en proceso + aplicado
  const [[y]] = await pool.query(
    `
    SELECT COALESCE(SUM(amount),0) AS totalYield
    FROM transactions
    WHERE user_id=? AND type='yield'
    `,
    [userId]
  );

  res.json({
    summary: {
      balance: Number(bal?.balance || 0),
      totalYield: Number(y?.totalYield || 0),
    },
    products,
    transactions: txns,
  });
});

// --- Catálogo (para oportunidades) ---
app.get("/products", async (req, res) => {
  const status = req.query.status;
  if (status) {
    const [rows] = await pool.query("SELECT * FROM products WHERE status=?", [
      status,
    ]);
    return res.json(rows);
  }
  const [rows] = await pool.query("SELECT * FROM products");
  res.json(rows);
});

// --- Retiro + notificación por email ---
app.post("/withdraw", async (req, res) => {
  const { userId, productId, amount } = req.body;

  if (!userId || !amount) {
    return res.status(400).json({ message: "userId y amount son requeridos" });
  }

  // guardar retiro
  const [r1] = await pool.query(
    "INSERT INTO withdrawals (user_id, amount) VALUES (?, ?)",
    [userId, amount]
  );

  // registrar transacción (opcional, recomendado para saldo)
  // si quieres que el saldo baje al instante, registra la salida como "withdrawal" negativa
  await pool.query(
    `
    INSERT INTO transactions (user_id, product_id, type, description, reference, status, amount, txn_date)
    VALUES (?, ?, 'withdrawal', 'Solicitud de retiro', ?, 'En proceso', ?, NOW())
    `,
    [
      userId,
      productId || null,
      `WDR-${String(r1.insertId).padStart(6, "0")}`,
      -Math.abs(Number(amount)),
    ]
  );

  // datos para email (cliente + producto)
  const [[u]] = await pool.query(
    "SELECT id, email, name FROM users WHERE id=? LIMIT 1",
    [userId]
  );

  let product = null;
  if (productId) {
    const [[p]] = await pool.query(
      "SELECT id, name FROM products WHERE id=? LIMIT 1",
      [productId]
    );
    product = p || null;
  }

  const iso = nowBogotaISO();
  const subject = `Azell | Retiro solicitado | ${u?.name || "Cliente"}`;
  const prettyAmount = formatMoneyMXN(amount);

  const text =
    `Solicitud de retiro\n\n` +
    `Cliente: ${u?.name || "-"} (${u?.email || "-"})\n` +
    `Producto: ${product?.name || "No especificado"}\n` +
    `Valor: ${prettyAmount}\n` +
    `Fecha/hora (ISO): ${iso}\n` +
    `ID retiro: ${r1.insertId}\n`;

  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.4">
      <h2>Solicitud de retiro</h2>
      <p><b>Cliente:</b> ${u?.name || "-"}<br/>
         <b>Correo:</b> ${u?.email || "-"}<br/>
         <b>Producto:</b> ${product?.name || "No especificado"}<br/>
         <b>Valor:</b> ${prettyAmount}<br/>
         <b>Fecha/hora (ISO):</b> ${iso}<br/>
         <b>ID retiro:</b> ${r1.insertId}
      </p>
    </div>
  `;

  try {
    const mailRes = await sendWithdrawEmail({
      to: process.env.WITHDRAW_NOTIFY_TO,
      from: process.env.WITHDRAW_NOTIFY_FROM || process.env.SMTP_USER,
      subject,
      html,
      text,
    });

    // log interno
    console.log("WITHDRAW:", { userId, productId, amount, mailRes });

    return res.json({
      status: "Pendiente",
      withdrawalId: r1.insertId,
      notified: !!mailRes.sent,
    });
  } catch (e) {
    console.error("EMAIL_ERROR:", e?.message || e);
    // no rompemos la UX del cliente: retiro queda creado igual
    return res.json({
      status: "Pendiente",
      withdrawalId: r1.insertId,
      notified: false,
    });
  }
});

// --- Start ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Azell API running on port", port);
});
