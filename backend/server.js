
require("dotenv").config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length === 0) {
    console.error("JWT_SECRET is required. Add a non-empty value to backend/.env before starting the server.");
    process.exit(1);
}

const express = require("express");
const connectDatabase = require("./src/config/database");
const authRoutes = require("./src/routes/authRoutes");
const complaintRoutes = require("./src/routes/complaintRoutes");
const healthRoutes = require("./src/routes/healthRoutes");
const userRoutes = require("./src/routes/userRoutes");
const authorityRoutes = require("./src/routes/authorityRoutes");
const adminRoutes = require("./src/routes/adminRoutes");

const app = express();

const PORT = Number(process.env.PORT) || 5000;

app.use(express.json({ limit: "10kb" }));
app.use("/api", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/complaints", complaintRoutes);
app.use("/api/users", userRoutes);
app.use("/api/authority", authorityRoutes);
app.use("/api/admin", adminRoutes);

app.use((error, req, res, next) => {
    if (error && error.type === "entity.parse.failed") {
        return res.status(400).json({
            success: false,
            message: "Request body must be valid JSON"
        });
    }

    if (error && error.type === "entity.too.large") {
        return res.status(413).json({
            success: false,
            message: "Request body is too large"
        });
    }

    console.error("Request failed due to an unexpected error.");
    return res.status(500).json({
        success: false,
        message: "An unexpected error occurred"
    });
});

async function startServer() {
    try {
        await connectDatabase();

        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    } catch (error) {
        const errorType = error instanceof Error ? error.name : "Unknown error";
        console.error("MongoDB connection failed. Check MONGODB_URI and ensure MongoDB is running.");
        console.error(`Error type: ${errorType}`);
        process.exitCode = 1;
    }
}

startServer();
