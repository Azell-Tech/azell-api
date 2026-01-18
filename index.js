import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// DB
// =====================
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
});

// =====================
// Health
// =====================
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

// =====================
// Login
// =====================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email y contraseña requeridos" });
    }

    const [rows] = await pool.query(
      `
      SELECT 
        id,
        email,
        name,
        must_change_password
      FROM users
      WHERE email=? AND password=?
      LIMIT 1
      `,
      [email, password]
    );

    if (!rows.length) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    const u = rows[0];

    res.json({
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
      },
      mustChangePassword: !!u.must_change_password,
    });
  } catch (err) {
    console.error("LOGIN_ERROR:", err);
    res.status(500).json({ message: "Error interno de autenticación" });
  }
});

// =====================
// Cambio de contraseña (primer acceso)
// =====================
app.post("/change-password", async (req, res) => {
  try {
    const { userId, oldPassword, newPassword } = req.body;

    if (!userId || !oldPassword || !newPassword) {
      return res.status(400).json({ message: "Datos incompletos" });
    }

    if (String(newPassword).length < 8) {
      return res
        .status(400)
        .json({ message: "La contraseña debe tener mínimo 8 caracteres" });
    }

    const [rows] = await pool.query(
      `
      SELECT id
      FROM users
      WHERE id=? AND password=?
      LIMIT 1
      `,
      [userId, oldPassword]
    );

    if (!rows.length) {
      return res
        .status(401)
        .json({ message: "Contraseña actual incorrecta" });
    }

    await pool.query(
      `
      UPDATE users
      SET password=?, must_change_password=0
      WHERE id=?
      `,
      [newPassword, userId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("CHANGE_PASSWORD_ERROR:", err);
    res.status(500).json({ message: "Error al cambiar contraseña" });
  }
});

// =====================
// Dashboard (resumen)
// =====================
app.get("/dashboard/:userId", async (req, res) => {
  try {
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
        p.id,
        p.name,
        p.subtitle,
        p.term,
        p.rate,
        p.status,
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
        id,
        type,
        description,
        reference,
        status,
        amount,
        txn_date AS date
      FROM transactions
      WHERE user_id=?
      ORDER BY txn_date DESC
      LIMIT 10
      `,
      [userId]
    );

    const invested = summary?.invested || 0;

    res.json({
      summary: {
        invested,
        projectedYield: Math.round(invested * 0.12),
      },
      products,
      transactions: txns,
    });
  } catch (err) {
    console.error("DASHBOARD_ERROR:", err);
    res.status(500).json({ message: "Error cargando dashboard" });
  }
});

// =====================
// Catálogo
// =====================
app.get("/products", async (_, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM products");
    res.json(rows);
  } catch (err) {
    console.error("PRODUCTS_ERROR:", err);
    res.status(500).json({ message: "Error cargando catálogo" });
  }
});

// =====================
// Retiro
// =====================
app.post("/withdraw", async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({ message: "Datos incompletos" });
    }

    await pool.query(
      "INSERT INTO withdrawals (user_id, amount) VALUES (?, ?)",
      [userId, amount]
    );

    console.log("RETIRO SOLICITADO:", { userId, amount });

    res.json({ status: "Pendiente" });
  } catch (err) {
    console.error("WITHDRAW_ERROR:", err);
    res.status(500).json({ message: "Error solicitando retiro" });
  }
});

// =====================
// Start
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Azell API running on port", port);
});
