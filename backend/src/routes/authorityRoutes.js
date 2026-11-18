const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const {
    getDashboardStats,
    getAuthorityComplaintById,
    reviewCitizenVerification
} = require("../controllers/authorityController");

const router = express.Router();

router.get("/dashboard/stats", authMiddleware, getDashboardStats);
router.patch(
    "/complaints/:id/verification-review",
    authMiddleware,
    reviewCitizenVerification
);
router.get("/complaints/:id", authMiddleware, getAuthorityComplaintById);

module.exports = router;
