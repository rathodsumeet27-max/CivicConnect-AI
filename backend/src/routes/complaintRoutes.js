const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const {
    submitComplaint,
    getMyComplaints,
    getComplaintById,
    getAllComplaints,
    getAssignedComplaints,
    updateComplaintStatus,
    assignComplaintWorker,
    startComplaintWork,
    claimComplaintCompletion,
    submitCitizenVerification,
    submitWorkerProgressEvidence
} = require("../controllers/complaintController");

const router = express.Router();

router.get("/", authMiddleware, getAllComplaints);
router.post("/", authMiddleware, submitComplaint);
router.get("/my", authMiddleware, getMyComplaints);
router.get("/assigned", authMiddleware, getAssignedComplaints);
router.patch("/:id/status", authMiddleware, updateComplaintStatus);
router.patch("/:id/assign", authMiddleware, assignComplaintWorker);
router.patch("/:id/start", authMiddleware, startComplaintWork);
router.patch("/:id/claim-completion", authMiddleware, claimComplaintCompletion);
router.post("/:id/citizen-verification", authMiddleware, submitCitizenVerification);
router.post("/:id/progress-evidence", authMiddleware, submitWorkerProgressEvidence);
router.get("/:id", authMiddleware, getComplaintById);

module.exports = router;
