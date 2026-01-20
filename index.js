// D:\Desarrollo\Azell\azell-api\index.js
// Express + MySQL (sin email)

import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";

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

function mustInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function mustAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function padRef(id) {
  return `WDR-${String(id).padStart(6, "0")}`;
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
      id, type, description, reference, status, amount,
      txn_date AS date,
      product_id AS productId
    FROM transactions
    WHERE user_id=?
    ORDER BY txn_date DESC, id DESC
    LIMIT 100
    `,
    [userId]
  );

  const [[y]] = await pool.query(
    `
    SELECT COALESCE(SUM(amount),0) AS totalYield
    FROM transactions
    WHERE user_id=? AND type='yield' AND status='Aplicado'
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

// --- Withdraw: request + txn negative (no email) ---
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

    // 1) validar que el producto está asignado al usuario + valor invertido
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

    // 2) calcular retiros en proceso y aplicados para este producto
    // - aplicados: transacciones withdrawal con status='Aplicado'
    // - en proceso: transacciones withdrawal con status='En proceso'
    const [[wAgg]] = await conn.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN status='En proceso' THEN -amount ELSE 0 END),0) AS pendingWithdrawals,
        COALESCE(SUM(CASE WHEN status='Aplicado' THEN -amount ELSE 0 END),0) AS appliedWithdrawals
      FROM transactions
      WHERE user_id=? AND product_id=? AND type='withdrawal'
      `,
      [userId, productId]
    );

    const pending = Number((wAgg && wAgg.pendingWithdrawals) || 0);
    const applied = Number((wAgg && wAgg.appliedWithdrawals) || 0);

    // disponible real para nuevos retiros:
    const available = invested - pending - applied;

    if (amount > available) {
      await conn.rollback();
      return res.status(400).json({
        message: `El monto excede el disponible para retiro.`,
        invested,
        pendingWithdrawals: pending,
        appliedWithdrawals: applied,
        available,
      });
    }

    // 3) crear solicitud en withdrawal_requests (tu enum NO tiene "Cancelado", usamos En proceso / Rechazado)
    const [rReq] = await conn.query(
      `
      INSERT INTO withdrawal_requests (user_id, product_id, amount, status, requested_at)
      VALUES (?, ?, ?, 'En proceso', NOW())
      `,
      [userId, productId, amount]
    );

    const withdrawalId = rReq.insertId;
    const reference = padRef(withdrawalId);

    // 4) registrar transacción negativa asociada (misma referencia)
    await conn.query(
      `
      INSERT INTO transactions (user_id, product_id, type, description, reference, status, amount, txn_date)
      VALUES (?, ?, 'withdrawal', 'Solicitud de retiro', ?, 'En proceso', ?, NOW())
      `,
      [userId, productId, reference, -Math.abs(amount)]
    );

    await conn.commit();

    return res.json({
      ok: true,
      status: "En proceso",
      withdrawalId,
      reference,
      invested,
      pendingWithdrawals: pending + amount, // ya incluye esta nueva
      appliedWithdrawals: applied,
      availableBefore: available,
      availableAfter: available - amount,
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

// --- Cancel withdrawal request (only if still pending/in progress) ---
app.post("/withdraw/cancel", async (req, res) => {
  const userId = mustInt(req.body && req.body.userId);
  const withdrawalId = mustInt(req.body && req.body.withdrawalId);

  if (!userId || !withdrawalId) {
    return res.status(400).json({ message: "userId y withdrawalId son requeridos" });
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [[wr]] = await conn.query(
      `
      SELECT id, user_id, product_id, amount, status
      FROM withdrawal_requests
      WHERE id=? AND user_id=?
      LIMIT 1
      `,
      [withdrawalId, userId]
    );

    if (!wr) {
      await conn.rollback();
      return res.status(404).json({ message: "Solicitud no encontrada" });
    }

    const status = String(wr.status || "");
    if (status !== "En proceso" && status !== "Pendiente") {
      await conn.rollback();
      return res.status(400).json({
        message: "Solo se pueden cancelar solicitudes en estado Pendiente o En proceso",
        status,
      });
    }

    const reference = padRef(withdrawalId);

    // marcar solicitud como Rechazado (equivale a cancelado por el usuario)
    await conn.query(
      `
      UPDATE withdrawal_requests
      SET status='Rechazado', processed_at=NOW(), notes=COALESCE(notes,'Cancelado por el usuario')
      WHERE id=? AND user_id=?
      `,
      [withdrawalId, userId]
    );

    // marcar la transacción asociada como Rechazado (si existe)
    await conn.query(
      `
      UPDATE transactions
      SET status='Rechazado'
      WHERE user_id=? AND reference=? AND type='withdrawal'
      `,
      [userId, reference]
    );

    await conn.commit();

    return res.json({ ok: true, status: "Rechazado", withdrawalId, reference });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error("CANCEL_WITHDRAW_ERROR:", e && e.message ? e.message : e);
    return res.status(500).json({ message: "Error cancelando retiro" });
  } finally {
    conn.release();
  }
});

// --- Start ---
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log("Azell API running on port", port);
});
