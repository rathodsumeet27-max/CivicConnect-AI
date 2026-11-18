const Complaint = require("../models/Complaint");
const mongoose = require("mongoose");

const authorizedRoles = ["authority", "admin"];
const statuses = Complaint.schema.path("status").enumValues;
const categories = Complaint.schema.path("category").enumValues;
const verificationReviewDecisions = ["Verified", "Inconclusive", "Rejected", "Reopened"];

/**
 * Returns total, per-status, and per-category counts. Every model enum value is included,
 * with zero for values that have no matching complaints.
 */
async function getDashboardStats(req, res) {
    if (!req.user || !authorizedRoles.includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: "Only authority and admin users can view dashboard statistics"
        });
    }

    try {
        const [stats] = await Complaint.aggregate([
            {
                $facet: {
                    total: [{ $count: "count" }],
                    byStatus: [
                        {
                            $group: {
                                _id: "$status",
                                count: { $sum: 1 }
                            }
                        }
                    ],
                    byCategory: [
                        {
                            $group: {
                                _id: "$category",
                                count: { $sum: 1 }
                            }
                        }
                    ]
                }
            }
        ]);

        const countsByStatus = Object.fromEntries(statuses.map((status) => [status, 0]));
        const countsByCategory = Object.fromEntries(categories.map((category) => [category, 0]));

        for (const { _id, count } of stats.byStatus) {
            if (Object.prototype.hasOwnProperty.call(countsByStatus, _id)) {
                countsByStatus[_id] = count;
            }
        }

        for (const { _id, count } of stats.byCategory) {
            if (Object.prototype.hasOwnProperty.call(countsByCategory, _id)) {
                countsByCategory[_id] = count;
            }
        }

        return res.status(200).json({
            success: true,
            data: {
                totalComplaints: stats.total.length > 0 ? stats.total[0].count : 0,
                countsByStatus,
                countsByCategory
            }
        });
    } catch (error) {
        console.error("Fetching authority dashboard statistics failed unexpectedly.");
        return res.status(500).json({
            success: false,
            message: "Unable to fetch dashboard statistics at this time"
        });
    }
}

function serializeRelatedUser(user) {
    if (!user || !user._id || typeof user.name !== "string") {
        return null;
    }

    return {
        id: user._id.toString(),
        name: user.name
    };
}

async function getAuthorityComplaintById(req, res) {
    if (!req.user || !authorizedRoles.includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: "Only authority and admin users can view complaint details"
        });
    }

    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) {
        return res.status(400).json({
            success: false,
            message: "Complaint ID must be a valid MongoDB ObjectId"
        });
    }

    try {
        const complaint = await Complaint.findById(id)
            .select(
                "title description category location images status originalComplainantId assignedWorkerId createdAt updatedAt"
            )
            .populate({ path: "originalComplainantId", select: "name" })
            .populate({ path: "assignedWorkerId", select: "name" })
            .lean();

        if (!complaint) {
            return res.status(404).json({
                success: false,
                message: "Complaint not found"
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                complaint: {
                    id: complaint._id.toString(),
                    title: complaint.title,
                    description: complaint.description,
                    category: complaint.category,
                    location: {
                        address: complaint.location.address,
                        latitude: complaint.location.latitude,
                        longitude: complaint.location.longitude
                    },
                    images: complaint.images,
                    status: complaint.status,
                    originalComplainant: serializeRelatedUser(complaint.originalComplainantId),
                    assignedWorker: serializeRelatedUser(complaint.assignedWorkerId),
                    createdAt: complaint.createdAt,
                    updatedAt: complaint.updatedAt
                }
            }
        });
    } catch (error) {
        console.error("Fetching authority complaint failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to fetch complaint at this time"
        });
    }
}

async function reviewCitizenVerification(req, res) {
    if (!req.user || !authorizedRoles.includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: "Only authority and admin users can review citizen verification"
        });
    }

    if (!mongoose.isObjectIdOrHexString(req.user.id)) {
        return res.status(401).json({
            success: false,
            message: "Authentication required or token is invalid"
        });
    }

    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) {
        return res.status(400).json({
            success: false,
            message: "Complaint ID must be a valid MongoDB ObjectId"
        });
    }

    const body = req.body;
    const allowedFields = ["decision", "reason"];
    if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).some((field) => !allowedFields.includes(field))
    ) {
        return res.status(400).json({
            success: false,
            message: "Request body must contain only decision and reason"
        });
    }

    const errors = {};
    if (!verificationReviewDecisions.includes(body.decision)) {
        errors.decision = "A valid verification review decision is required";
    }

    let reason;
    if (body.reason !== undefined) {
        if (typeof body.reason !== "string") {
            errors.reason = "Review reason must be a string";
        } else {
            reason = body.reason.trim();
            if (reason.length > 1000) {
                errors.reason = "Review reason cannot exceed 1000 characters";
            }
        }
    }

    if (Object.keys(errors).length > 0) {
        return res.status(400).json({
            success: false,
            message: "Verification review validation failed",
            errors
        });
    }

    const review = {
        decision: body.decision,
        reviewedBy: req.user.id,
        reviewedAt: new Date()
    };
    if (reason !== undefined) {
        review.reason = reason;
    }

    try {
        const updatedComplaint = await Complaint.findOneAndUpdate(
            {
                _id: id,
                status: "Evidence Verification Pending",
                citizenVerification: { $exists: true, $ne: null }
            },
            {
                $set: { status: body.decision },
                $push: { authorityVerificationReviews: review }
            },
            { new: true, runValidators: true }
        )
            .select("_id status authorityVerificationReviews")
            .lean();

        if (!updatedComplaint) {
            const complaint = await Complaint.findById(id)
                .select("status citizenVerification")
                .lean();

            if (!complaint) {
                return res.status(404).json({
                    success: false,
                    message: "Complaint not found"
                });
            }

            if (complaint.status !== "Evidence Verification Pending") {
                return res.status(409).json({
                    success: false,
                    message: "Complaint is no longer awaiting verification review"
                });
            }

            if (complaint.citizenVerification === null || complaint.citizenVerification === undefined) {
                return res.status(409).json({
                    success: false,
                    message: "Citizen verification must be submitted before review"
                });
            }

            return res.status(409).json({
                success: false,
                message: "Verification review could not be completed; reload and try again"
            });
        }

        const reviews = updatedComplaint.authorityVerificationReviews;
        const savedReview = reviews[reviews.length - 1];
        const serializedReview = {
            decision: savedReview.decision,
            reviewedBy: savedReview.reviewedBy.toString(),
            reviewedAt: savedReview.reviewedAt
        };
        if (savedReview.reason !== undefined) {
            serializedReview.reason = savedReview.reason;
        }

        return res.status(200).json({
            success: true,
            data: {
                complaint: {
                    id: updatedComplaint._id.toString(),
                    status: updatedComplaint.status,
                    verificationReview: serializedReview
                }
            }
        });
    } catch (error) {
        console.error("Reviewing citizen verification failed unexpectedly.");
        return res.status(500).json({
            success: false,
            message: "Unable to review citizen verification at this time"
        });
    }
}

module.exports = {
    getDashboardStats,
    getAuthorityComplaintById,
    reviewCitizenVerification
};
