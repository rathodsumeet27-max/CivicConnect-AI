"use strict";

const express = require("express");
const mongoose = require("mongoose");
const connectDatabase = require("../src/config/database");
const authRoutes = require("../src/routes/authRoutes");
const complaintRoutes = require("../src/routes/complaintRoutes");
const healthRoutes = require("../src/routes/healthRoutes");
const userRoutes = require("../src/routes/userRoutes");
const authorityRoutes = require("../src/routes/authorityRoutes");

const expectedDatabaseName = "civicconnect_ai_worker_workflow_test";
const developmentDatabaseName = "civicconnect_ai";

function validateConfiguration() {
    const mongoUri = process.env.CIVICCONNECT_TEST_MONGODB_URI;
    const portValue = process.env.CIVICCONNECT_TEST_PORT;

    if (!mongoUri || process.env.CIVICCONNECT_ALLOW_TEST_CLEANUP !== "YES") {
        throw new Error("Explicit worker workflow test configuration is required");
    }

    let databaseName;
    try {
        const parsedUri = new URL(mongoUri);
        databaseName = decodeURIComponent(parsedUri.pathname.replace(/^\/+/, ""));
        if (!["mongodb:", "mongodb+srv:"].includes(parsedUri.protocol)) {
            throw new Error();
        }
    } catch {
        throw new Error("Worker workflow test MongoDB URI is invalid");
    }

    if (
        databaseName !== expectedDatabaseName
        || databaseName === developmentDatabaseName
    ) {
        throw new Error("Worker workflow tests require the isolated test database");
    }

    if (!/^[1-9]\d*$/.test(portValue || "")) {
        throw new Error("An explicit worker workflow test port is required");
    }

    const port = Number(portValue);
    if (!Number.isSafeInteger(port) || port > 65535) {
        throw new Error("Worker workflow test port is invalid");
    }

    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length === 0) {
        throw new Error("Worker workflow test JWT secret is required");
    }

    process.env.MONGODB_URI = mongoUri;
    process.env.PORT = String(port);
    return port;
}

function sendStartupMessage(message) {
    if (typeof process.send === "function" && process.connected) {
        process.send(message);
    }
}

async function startServer() {
    const port = validateConfiguration();
    await connectDatabase();

    const app = express();
    app.use(express.json({ limit: "10kb" }));
    app.use("/api", healthRoutes);
    app.use("/api/auth", authRoutes);
    app.use("/api/complaints", complaintRoutes);
    app.use("/api/users", userRoutes);
    app.use("/api/authority", authorityRoutes);

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

        console.error("Test server request failed unexpectedly.");
        return res.status(500).json({
            success: false,
            message: "An unexpected error occurred"
        });
    });

    const server = app.listen(port);
    server.once("listening", () => sendStartupMessage({ type: "ready" }));
    server.once("error", async () => {
        sendStartupMessage({ type: "startup-error" });
        await mongoose.disconnect();
        process.exitCode = 1;
    });
}

startServer().catch(async () => {
    sendStartupMessage({ type: "startup-error" });
    await mongoose.disconnect();
    process.exitCode = 1;
});
