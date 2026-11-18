const mongoose = require("mongoose");
const maximumWorkerProgressEvidenceEntries = 50;

const categories = [
    "Road Damage",
    "Garbage",
    "Water Supply",
    "Streetlight",
    "Drainage",
    "Other"
];

const statuses = [
    "Submitted",
    "Under Review",
    "Assigned",
    "In Progress",
    "Work Claimed Completed",
    "Evidence Verification Pending",
    "Verified",
    "Inconclusive",
    "Rejected",
    "Reopened"
];

const locationSchema = new mongoose.Schema(
    {
        address: {
            type: String,
            required: [true, "Location address is required"],
            trim: true
        },
        latitude: {
            type: Number,
            required: [true, "Latitude is required"],
            min: [-90, "Latitude must be between -90 and 90"],
            max: [90, "Latitude must be between -90 and 90"]
        },
        longitude: {
            type: Number,
            required: [true, "Longitude is required"],
            min: [-180, "Longitude must be between -180 and 180"],
            max: [180, "Longitude must be between -180 and 180"]
        }
    },
    { _id: false }
);

const citizenVerificationSchema = new mongoose.Schema(
    {
        response: {
            type: String,
            required: true,
            enum: ["resolved", "not_resolved"]
        },
        notes: {
            type: String,
            trim: true,
            maxlength: [1000, "Notes cannot exceed 1000 characters"]
        },
        evidenceImages: {
            type: [
                {
                    type: String,
                    trim: true,
                    validate: {
                        validator(value) {
                            try {
                                const url = new URL(value);
                                return url.protocol === "http:" || url.protocol === "https:";
                            } catch {
                                return false;
                            }
                        },
                        message: "Each image must be a valid HTTP or HTTPS URL"
                    }
                }
            ],
            default: []
        },
        submittedAt: {
            type: Date
        },
        submittedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User"
        }
    },
    { _id: false }
);

const workerProgressEvidenceSchema = new mongoose.Schema(
    {
        note: {
            type: String,
            required: true,
            trim: true,
            maxlength: [1000, "Progress note cannot exceed 1000 characters"]
        },
        evidenceImages: {
            type: [
                {
                    type: String,
                    trim: true,
                    validate: {
                        validator(value) {
                            try {
                                const url = new URL(value);
                                return url.protocol === "http:" || url.protocol === "https:";
                            } catch {
                                return false;
                            }
                        },
                        message: "Each image must be a valid HTTP or HTTPS URL"
                    }
                }
            ],
            default: [],
            validate: {
                validator(images) {
                    return Array.isArray(images) && images.length <= 5;
                },
                message: "Progress evidence cannot contain more than 5 images"
            }
        },
        submittedAt: {
            type: Date,
            required: true
        },
        submittedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        }
    },
    { _id: false }
);

const authorityVerificationReviewSchema = new mongoose.Schema(
    {
        decision: {
            type: String,
            required: true,
            enum: ["Verified", "Inconclusive", "Rejected", "Reopened"]
        },
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },
        reviewedAt: {
            type: Date,
            required: true
        },
        reason: {
            type: String,
            trim: true,
            maxlength: [1000, "Review reason cannot exceed 1000 characters"]
        }
    },
    { _id: false }
);

const complaintSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: [true, "Title is required"],
            trim: true,
            minlength: [5, "Title must be at least 5 characters long"],
            maxlength: [150, "Title cannot exceed 150 characters"]
        },
        description: {
            type: String,
            required: [true, "Description is required"],
            trim: true,
            minlength: [20, "Description must be at least 20 characters long"],
            maxlength: [3000, "Description cannot exceed 3000 characters"]
        },
        category: {
            type: String,
            required: [true, "Category is required"],
            enum: categories
        },
        location: {
            type: locationSchema,
            required: [true, "Location is required"]
        },
        images: {
            type: [
                {
                    type: String,
                    trim: true,
                    validate: {
                        validator(value) {
                            try {
                                const url = new URL(value);
                                return url.protocol === "http:" || url.protocol === "https:";
                            } catch {
                                return false;
                            }
                        },
                        message: "Each image must be a valid HTTP or HTTPS URL"
                    }
                }
            ],
            default: []
        },
        status: {
            type: String,
            enum: statuses,
            default: "Submitted"
        },
        originalComplainantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Original complainant is required"]
        },
        assignedWorkerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User"
        },
        citizenVerification: {
            type: citizenVerificationSchema,
            default: null
        },
        workerProgressEvidence: {
            type: [workerProgressEvidenceSchema],
            default: [],
            validate: {
                validator(entries) {
                    return Array.isArray(entries)
                        && entries.length <= maximumWorkerProgressEvidenceEntries;
                },
                message: "Worker progress evidence cannot exceed 50 entries"
            }
        },
        authorityVerificationReviews: {
            type: [authorityVerificationReviewSchema],
            default: []
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Complaint", complaintSchema);
