"use strict";

const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const requireCurrentAdmin = require("../middleware/adminMiddleware");
const {
    getAdminUsers,
    getAdminUserById,
    updateAdminUserRole
} = require("../controllers/adminController");

const router = express.Router();

router.get("/users", authMiddleware, requireCurrentAdmin, getAdminUsers);
router.get("/users/:id", authMiddleware, requireCurrentAdmin, getAdminUserById);
router.patch("/users/:id/role", authMiddleware, requireCurrentAdmin, updateAdminUserRole);

module.exports = router;
