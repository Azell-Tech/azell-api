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
});

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

  res.json({
    user: rows[0],
  });
});

// --- Productos del usuario (dashboard) ---
app.get("/dashboard/:userId", async (req, res) => {
  const { userId } = req.params;

  const [[summary]] = await pool.query(
    `
    SELECT 
      SUM(up.invested_amount) AS invested
    FROM user_products up
    WHERE up.user_id=?
    `,
    [userId]
  );

  const [products] = await pool.query(
    `
    SELECT 
      p.id, p.name, p.subtitle, p.term, p.rate, p.status,
      up.invested_amount AS invested,
      up.maturity_date AS maturity
    FROM user_products up
    JOIN products p ON p.id = up.product_id
    WHERE up.user_id=?
    `,
    [userId]
  );

  const [txns] = await pool.query(
    `
    SELECT 
      id, type, description, reference, status, amount, txn_date AS date
    FROM transactions
    WHERE user_id=?
    ORDER BY txn_date DESC
    LIMIT 10
    `,
    [userId]
  );

  res.json({
    summary: {
      invested: summary?.invested || 0,
      projectedYield: Math.round((summary?.invested || 0) * 0.12),
    },
    products,
    transactions: txns,
  });
});

// --- Catálogo ---
app.get("/products", async (_, res) => {
  const [rows] = await pool.query("SELECT * FROM products");
  res.json(rows);
});

// --- Retiro ---
app.post("/withdraw", async (req, res) => {
  const { userId, amount } = req.body;

  await pool.query(
    "INSERT INTO withdrawals (user_id, amount) VALUES (?, ?)",
    [userId, amount]
  );

  // Aquí luego conectas WhatsApp (Twilio / Cloud API)
  console.log("RETIRO SOLICITADO:", { userId, amount });

  res.json({
    status: "Pendiente",
  });
});

// --- Start ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Azell API running on port", port);
});
