// api/index.js (Express + MySQL) — JavaScript puro (sin TS)
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

function nowISO() {
  return new Date().toISOString();
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

function mustInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function mustAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

// --- Health ---
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

// --- Login ---
app.post("/login", async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: "email y password son requeridos" });
  }

  const [rows] = await pool.query(
    "SELECT id, email, name FROM users WHERE email=? AND password=? LIMIT 1",
    [email, password]
  );

  if (!rows || !rows.length) {
    return res.status(401).json({ message: "Credenciales inválidas" });
  }

  res.json({ user: rows[0] });
});

// --- Dashboard ---
app.get("/dashboard/:userId", async (req, res) => {
  const userId = mustInt(req.params.userId);
  if (!userId) return res.status(400).json({ message: "userId inválido" });

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
      balance: Number((bal && bal.balance) || 0),
      totalYield: Number((y && y.totalYield) || 0),
    },
    products: Array.isArray(products) ? products : [],
    transactions: Array.isArray(txns) ? txns : [],
  });
});

// --- Products catalog (opportunities) ---
app.get("/products", async (req, res) => {
  const status = String(req.query.status || "").trim();

  if (status) {
    const [rows] = await pool.query(
      "SELECT * FROM products WHERE status=? ORDER BY id ASC",
      [status]
    );
    return res.json(Array.isArray(rows) ? rows : []);
  }

  const [rows] = await pool.query("SELECT * FROM products ORDER BY id ASC");
  res.json(Array.isArray(rows) ? rows : []);
});

// --- Withdraw: request + txn negative (affects balance) + mail optional ---
app.post("/withdraw", async (req, res) => {
  const userId = mustInt(req.body && req.body.userId);
  const productId = mustInt(req.body && req.body.productId);
  const amount = mustAmount(req.body && req.body.amount);

  if (!userId || !productId || !amount) {
    return res.status(400).json({
      message: "userId, productId y amount son requeridos",
    });
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // validar inversión del producto del usuario
    const [[up]] = await conn.query(
      `
      SELECT invested_amount
      FROM user_products
      WHERE user_id=? AND product_id=?
      LIMIT 1
      `,
      [userId, productId]
    );

    if (!up) {
      await conn.rollback();
      return res.status(404).json({ message: "Producto no asignado al usuario" });
    }

    const invested = Number(up.invested_amount || 0);
    if (!Number.isFinite(invested) || invested <= 0) {
      await conn.rollback();
      return res
        .status(400)
        .json({ message: "El producto no tiene inversión registrada" });
    }

    if (amount > invested) {
      await conn.rollback();
      return res.status(400).json({
        message: `El monto debe ser menor o igual a lo invertido (${formatMoneyMXN(
          invested
        )})`,
      });
    }

    // crear solicitud en withdrawal_requests
    const [rReq] = await conn.query(
      `
      INSERT INTO withdrawal_requests (user_id, product_id, amount, status, requested_at)
      VALUES (?, ?, ?, 'En proceso', NOW())
      `,
      [userId, productId, amount]
    );

    const withdrawalId = rReq.insertId;
    const reference = `WDR-${String(withdrawalId).padStart(6, "0")}`;

    // registrar transacción negativa
    await conn.query(
      `
      INSERT INTO transactions (user_id, product_id, type, description, reference, status, amount, txn_date)
      VALUES (?, ?, 'withdrawal', 'Solicitud de retiro', ?, 'En proceso', ?, NOW())
      `,
      [userId, productId, reference, -Math.abs(amount)]
    );

    await conn.commit();

    // email (mejor fuera de transacción)
    const [[u]] = await pool.query(
      "SELECT id, email, name FROM users WHERE id=? LIMIT 1",
      [userId]
    );

    const [[p]] = await pool.query(
      "SELECT id, name FROM products WHERE id=? LIMIT 1",
      [productId]
    );

    const iso = nowISO();
    const subject = `Azell | Retiro solicitado | ${(u && u.name) || "Cliente"}`;
    const prettyAmount = formatMoneyMXN(amount);

    const text =
      `Solicitud de retiro\n\n` +
      `Cliente: ${(u && u.name) || "-"} (${(u && u.email) || "-"})\n` +
      `Producto: ${(p && p.name) || "-"}\n` +
      `Valor: ${prettyAmount}\n` +
      `Fecha/hora (ISO): ${iso}\n` +
      `ID solicitud: ${withdrawalId}\n` +
      `Referencia: ${reference}\n`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height:1.45">
        <h2>Solicitud de retiro</h2>
        <p>
          <b>Cliente:</b> ${(u && u.name) || "-"}<br/>
          <b>Correo:</b> ${(u && u.email) || "-"}<br/>
          <b>Producto:</b> ${(p && p.name) || "-"}<br/>
          <b>Valor:</b> ${prettyAmount}<br/>
          <b>Fecha/hora (ISO):</b> ${iso}<br/>
          <b>ID solicitud:</b> ${withdrawalId}<br/>
          <b>Referencia:</b> ${reference}
        </p>
      </div>
    `;

    let notified = false;
    try {
      const mailRes = await sendWithdrawEmail({
        to: process.env.WITHDRAW_NOTIFY_TO,
        from: process.env.WITHDRAW_NOTIFY_FROM || process.env.SMTP_USER,
        subject,
        html,
        text,
      });
      notified = !!mailRes.sent;
      console.log("WITHDRAW:", {
        userId,
        productId,
        amount,
        withdrawalId,
        reference,
        notified,
        mailRes,
      });
    } catch (e) {
      console.error("EMAIL_ERROR:", e && e.message ? e.message : e);
    }

    return res.json({
      status: "En proceso",
      withdrawalId,
      reference,
      notified,
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error("WITHDRAW_ERROR:", e && e.message ? e.message : e);
    return res.status(500).json({ message: "Error procesando retiro" });
  } finally {
    conn.release();
  }
});

// --- Start ---
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log("Azell API running on port", port);
});
