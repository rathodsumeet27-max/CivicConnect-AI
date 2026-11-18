const Complaint = require("../models/Complaint");
const User = require("../models/User");
const mongoose = require("mongoose");

const allowedFields = ["title", "description", "category", "location", "images"];
const allowedLocationFields = ["address", "latitude", "longitude"];
const categories = Complaint.schema.path("category").enumValues;
const statuses = Complaint.schema.path("status").enumValues;
const listQueryFields = ["page", "limit", "status", "category"];
const assignedQueryFields = ["page", "limit"];
const maximumWorkerProgressEvidenceEntries = 50;
const authorityStatusTransitions = {
    Submitted: ["Under Review"],
    "Work Claimed Completed": ["Evidence Verification Pending"],
    "Evidence Verification Pending": []
};

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function validateComplaintInput(body) {
    const errors = {};
    let title;
    let description;
    let category;
    let location;
    let images;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: { body: "Request body must be a JSON object" } };
    }

    if (Object.keys(body).some((field) => !allowedFields.includes(field))) {
        return {
            errors: {
                body: "Only title, description, category, location, and images are allowed"
            }
        };
    }

    if (typeof body.title !== "string") {
        errors.title = "Title is required and must be a string";
    } else {
        title = body.title.trim();

        if (title.length < 5 || title.length > 150) {
            errors.title = "Title must be between 5 and 150 characters";
        }
    }

    if (typeof body.description !== "string") {
        errors.description = "Description is required and must be a string";
    } else {
        description = body.description.trim();

        if (description.length < 20 || description.length > 3000) {
            errors.description = "Description must be between 20 and 3000 characters";
        }
    }

    if (typeof body.category !== "string" || !categories.includes(body.category)) {
        errors.category = "Choose a valid complaint category";
    } else {
        category = body.category;
    }

    if (!body.location || typeof body.location !== "object" || Array.isArray(body.location)) {
        errors.location = "Location must include an address, latitude, and longitude";
    } else {
        if (Object.keys(body.location).some((field) => !allowedLocationFields.includes(field))) {
            errors.location = "Location may only contain address, latitude, and longitude";
        } else {
            const { address, latitude, longitude } = body.location;
            location = {};

            if (typeof address !== "string" || address.trim().length === 0) {
                errors["location.address"] = "Location address is required";
            } else {
                location.address = address.trim();
            }

            if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
                errors["location.latitude"] = "Latitude must be a number between -90 and 90";
            } else {
                location.latitude = latitude;
            }

            if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
                errors["location.longitude"] = "Longitude must be a number between -180 and 180";
            } else {
                location.longitude = longitude;
            }
        }
    }

    if (body.images !== undefined) {
        if (!Array.isArray(body.images)) {
            errors.images = "Images must be an array of HTTP or HTTPS URLs";
        } else {
            images = body.images.map((image) => (
                typeof image === "string" ? image.trim() : image
            ));

            if (!images.every((image) => typeof image === "string" && isHttpUrl(image))) {
                errors.images = "Each image must be a valid HTTP or HTTPS URL";
            }
        }
    }

    if (Object.keys(errors).length > 0) {
        return { errors };
    }

    return {
        values: {
            title,
            description,
            category,
            location,
            images
        }
    };
}

async function submitComplaint(req, res) {
    if (req.user.role !== "citizen") {
        return res.status(403).json({
            success: false,
            message: "Only citizens can submit complaints"
        });
    }

    const { errors, values } = validateComplaintInput(req.body);

    if (errors) {
        return res.status(400).json({
            success: false,
            message: "Complaint validation failed",
            errors
        });
    }

    try {
        const complaint = new Complaint({
            ...values,
            originalComplainantId: req.user.id
        });
        const savedComplaint = await complaint.save();

        return res.status(201).json({
            success: true,
            data: {
                complaint: {
                    id: savedComplaint._id.toString(),
                    title: savedComplaint.title,
                    description: savedComplaint.description,
                    category: savedComplaint.category,
                    location: {
                        address: savedComplaint.location.address,
                        latitude: savedComplaint.location.latitude,
                        longitude: savedComplaint.location.longitude
                    },
                    images: savedComplaint.images,
                    status: savedComplaint.status,
                    originalComplainantId: savedComplaint.originalComplainantId.toString(),
                    createdAt: savedComplaint.createdAt
                }
            }
        });
    } catch (error) {
        if (error && error.name === "ValidationError") {
            const validationErrors = Object.keys(error.errors || {}).reduce((result, field) => {
                result[field] = "Invalid or missing value";
                return result;
            }, {});

            return res.status(400).json({
                success: false,
                message: "Complaint validation failed",
                errors: validationErrors
            });
        }

        console.error("Complaint submission failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to submit complaint at this time"
        });
    }
}

async function getMyComplaints(req, res) {
    if (req.user.role !== "citizen") {
        return res.status(403).json({
            success: false,
            message: "Only citizens can access their complaints"
        });
    }

    try {
        const complaints = await Complaint.find({
            originalComplainantId: req.user.id
        })
            .select("title description category location images status createdAt updatedAt")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            data: {
                complaints: complaints.map((complaint) => ({
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
                    createdAt: complaint.createdAt,
                    updatedAt: complaint.updatedAt
                }))
            }
        });
    } catch (error) {
        console.error("Fetching citizen complaints failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to fetch complaints at this time"
        });
    }
}

async function getComplaintById(req, res) {
    if (req.user.role !== "citizen") {
        return res.status(403).json({
            success: false,
            message: "Only the original citizen complainant can view this complaint"
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
        const complaint = await Complaint.findOne({
            _id: id,
            originalComplainantId: req.user.id
        })
            .select("title description category location images status createdAt updatedAt")
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
                    createdAt: complaint.createdAt,
                    updatedAt: complaint.updatedAt
                }
            }
        });
    } catch (error) {
        console.error("Fetching complaint failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to fetch complaint at this time"
        });
    }
}

function parsePositiveInteger(value) {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const parsedValue = Number(value);
    return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}

function serializeComplaint(complaint) {
    return {
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
        createdAt: complaint.createdAt,
        updatedAt: complaint.updatedAt
    };
}

function isEmptyRequestBody(body) {
    return body === undefined
        || (
            body !== null
            && typeof body === "object"
            && !Array.isArray(body)
            && Object.keys(body).length === 0
        );
}

async function getAssignedComplaints(req, res) {
    if (req.user.role !== "worker") {
        return res.status(403).json({
            success: false,
            message: "Only workers can view assigned complaints"
        });
    }

    const queryParameters = req.query || {};

    if (Object.keys(queryParameters).some((field) => !assignedQueryFields.includes(field))) {
        return res.status(400).json({
            success: false,
            message: "Unsupported query parameter"
        });
    }

    const page = queryParameters.page === undefined
        ? 1
        : parsePositiveInteger(queryParameters.page);
    const limit = queryParameters.limit === undefined
        ? 10
        : parsePositiveInteger(queryParameters.limit);

    if (page === null || limit === null || limit > 50) {
        return res.status(400).json({
            success: false,
            message: "Page must be a positive integer and limit must be between 1 and 50"
        });
    }

    const skip = (page - 1) * limit;

    if (!Number.isSafeInteger(skip)) {
        return res.status(400).json({
            success: false,
            message: "Page value is too large"
        });
    }

    const filter = { assignedWorkerId: req.user.id };

    try {
        const [totalComplaints, complaints] = await Promise.all([
            Complaint.countDocuments(filter),
            Complaint.find(filter)
                .select("title description category location images status createdAt updatedAt")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        return res.status(200).json({
            success: true,
            data: {
                complaints: complaints.map(serializeComplaint),
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(totalComplaints / limit),
                    totalComplaints,
                    limit
                }
            }
        });
    } catch (error) {
        console.error("Fetching assigned complaints failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to fetch assigned complaints at this time"
        });
    }
}

async function submitCitizenVerification(req, res) {
    if (req.user.role !== "citizen") {
        return res.status(403).json({
            success: false,
            message: "Only citizens can submit complaint verification"
        });
    }

    if (!mongoose.isObjectIdOrHexString(req.params.id)) {
        return res.status(400).json({
            success: false,
            message: "Complaint ID must be a valid MongoDB ObjectId"
        });
    }

    const body = req.body;
    const errors = {};
    const allowedVerificationFields = ["response", "notes", "evidenceImages"];

    if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).some((field) => !allowedVerificationFields.includes(field))
    ) {
        return res.status(400).json({
            success: false,
            message: "Request body must contain only response, notes, and evidenceImages"
        });
    }

    if (!["resolved", "not_resolved"].includes(body.response)) {
        errors.response = "Response must be resolved or not_resolved";
    }

    let notes;
    if (body.notes !== undefined) {
        if (typeof body.notes !== "string") {
            errors.notes = "Notes must be a string";
        } else {
            notes = body.notes.trim();
            if (notes.length > 1000) {
                errors.notes = "Notes cannot exceed 1000 characters";
            }
        }
    }

    let evidenceImages = [];
    if (body.evidenceImages !== undefined) {
        if (!Array.isArray(body.evidenceImages)) {
            errors.evidenceImages = "Evidence images must be an array of HTTP or HTTPS URLs";
        } else {
            evidenceImages = body.evidenceImages.map((image) => (
                typeof image === "string" ? image.trim() : image
            ));

            if (!evidenceImages.every((image) => (
                typeof image === "string" && isHttpUrl(image)
            ))) {
                errors.evidenceImages = "Each evidence image must be a valid HTTP or HTTPS URL";
            }
        }
    }

    if (Object.keys(errors).length > 0) {
        return res.status(400).json({
            success: false,
            message: "Citizen verification validation failed",
            errors
        });
    }

    const citizenVerification = {
        response: body.response,
        evidenceImages,
        submittedAt: new Date(),
        submittedBy: req.user.id
    };
    if (notes !== undefined) {
        citizenVerification.notes = notes;
    }

    try {
        const updatedComplaint = await Complaint.findOneAndUpdate(
            {
                _id: req.params.id,
                originalComplainantId: req.user.id,
                status: "Evidence Verification Pending",
                citizenVerification: null
            },
            { $set: { citizenVerification } },
            { new: true, runValidators: true }
        )
            .select("citizenVerification")
            .lean();

        if (!updatedComplaint) {
            const complaint = await Complaint.findOne({
                _id: req.params.id,
                originalComplainantId: req.user.id
            })
                .select("status citizenVerification")
                .lean();

            if (!complaint) {
                return res.status(404).json({
                    success: false,
                    message: "Complaint not found"
                });
            }

            if (complaint.citizenVerification !== null && complaint.citizenVerification !== undefined) {
                return res.status(409).json({
                    success: false,
                    message: "Citizen verification has already been submitted"
                });
            }

            return res.status(409).json({
                success: false,
                message: "Complaint is not awaiting citizen verification"
            });
        }

        const verification = updatedComplaint.citizenVerification;
        return res.status(200).json({
            success: true,
            data: {
                citizenVerification: {
                    response: verification.response,
                    notes: verification.notes,
                    evidenceImages: verification.evidenceImages,
                    submittedAt: verification.submittedAt
                }
            }
        });
    } catch (error) {
        console.error("Submitting citizen verification failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to submit citizen verification at this time"
        });
    }
}

async function getAllComplaints(req, res) {
    if (!["authority", "admin"].includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: "Only authority and admin users can view all complaints"
        });
    }

    const queryParameters = req.query;

    if (Object.keys(queryParameters).some((field) => !listQueryFields.includes(field))) {
        return res.status(400).json({
            success: false,
            message: "Unsupported query parameter"
        });
    }

    const page = queryParameters.page === undefined
        ? 1
        : parsePositiveInteger(queryParameters.page);
    const limit = queryParameters.limit === undefined
        ? 10
        : parsePositiveInteger(queryParameters.limit);

    if (page === null || limit === null || limit > 50) {
        return res.status(400).json({
            success: false,
            message: "Page must be a positive integer and limit must be between 1 and 50"
        });
    }

    const skip = (page - 1) * limit;

    if (!Number.isSafeInteger(skip)) {
        return res.status(400).json({
            success: false,
            message: "Page value is too large"
        });
    }

    const filter = {};

    if (queryParameters.status !== undefined) {
        if (typeof queryParameters.status !== "string" || !statuses.includes(queryParameters.status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid complaint status filter"
            });
        }

        filter.status = queryParameters.status;
    }

    if (queryParameters.category !== undefined) {
        if (typeof queryParameters.category !== "string" || !categories.includes(queryParameters.category)) {
            return res.status(400).json({
                success: false,
                message: "Invalid complaint category filter"
            });
        }

        filter.category = queryParameters.category;
    }

    try {
        const [totalComplaints, complaints] = await Promise.all([
            Complaint.countDocuments(filter),
            Complaint.find(filter)
                .select("title description category location images status createdAt updatedAt")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        return res.status(200).json({
            success: true,
            data: {
                complaints: complaints.map((complaint) => ({
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
                    createdAt: complaint.createdAt,
                    updatedAt: complaint.updatedAt
                })),
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(totalComplaints / limit),
                    totalComplaints,
                    limit
                }
            }
        });
    } catch (error) {
        console.error("Fetching all complaints failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to fetch complaints at this time"
        });
    }
}

async function updateComplaintStatus(req, res) {
    if (!["authority", "admin"].includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: "Only authority and admin users can update complaint status"
        });
    }

    if (!mongoose.isObjectIdOrHexString(req.params.id)) {
        return res.status(400).json({
            success: false,
            message: "Complaint ID must be a valid MongoDB ObjectId"
        });
    }

    const body = req.body;

    if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).some((field) => field !== "status")
    ) {
        return res.status(400).json({
            success: false,
            message: "Request body must contain only the status field"
        });
    }

    if (typeof body.status !== "string" || !statuses.includes(body.status)) {
        return res.status(400).json({
            success: false,
            message: "A valid complaint status is required"
        });
    }

    try {
        const currentComplaint = await Complaint.findById(req.params.id).select("status");

        if (!currentComplaint) {
            return res.status(404).json({
                success: false,
                message: "Complaint not found"
            });
        }

        const allowedNextStatuses = Object.prototype.hasOwnProperty.call(
            authorityStatusTransitions,
            currentComplaint.status
        )
            ? authorityStatusTransitions[currentComplaint.status]
            : [];

        if (!allowedNextStatuses.includes(body.status)) {
            return res.status(400).json({
                success: false,
                message: "This complaint status transition is not allowed"
            });
        }

        const updatedComplaint = await Complaint.findOneAndUpdate(
            { _id: req.params.id, status: currentComplaint.status },
            { $set: { status: body.status } },
            { new: true, runValidators: true }
        )
            .select("title description category location images status createdAt updatedAt")
            .lean();

        if (!updatedComplaint) {
            const complaintStillExists = await Complaint.exists({ _id: req.params.id });

            if (!complaintStillExists) {
                return res.status(404).json({
                    success: false,
                    message: "Complaint not found"
                });
            }

            return res.status(409).json({
                success: false,
                message: "Complaint status changed; reload and try again"
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                complaint: {
                    id: updatedComplaint._id.toString(),
                    title: updatedComplaint.title,
                    description: updatedComplaint.description,
                    category: updatedComplaint.category,
                    location: {
                        address: updatedComplaint.location.address,
                        latitude: updatedComplaint.location.latitude,
                        longitude: updatedComplaint.location.longitude
                    },
                    images: updatedComplaint.images,
                    status: updatedComplaint.status,
                    createdAt: updatedComplaint.createdAt,
                    updatedAt: updatedComplaint.updatedAt
                }
            }
        });
    } catch (error) {
        console.error("Updating complaint status failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to update complaint status at this time"
        });
    }
}

async function assignComplaintWorker(req, res) {
    if (!["authority", "admin"].includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: "Only authority and admin users can assign workers"
        });
    }

    if (!mongoose.isObjectIdOrHexString(req.params.id)) {
        return res.status(400).json({
            success: false,
            message: "Complaint ID must be a valid MongoDB ObjectId"
        });
    }

    const body = req.body;

    if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).some((field) => field !== "workerId")
        || typeof body.workerId !== "string"
        || !mongoose.isObjectIdOrHexString(body.workerId)
    ) {
        return res.status(400).json({
            success: false,
            message: "Request body must contain only a valid workerId"
        });
    }

    try {
        const complaint = await Complaint.findById(req.params.id)
            .select("status assignedWorkerId");

        if (!complaint) {
            return res.status(404).json({
                success: false,
                message: "Complaint not found"
            });
        }

        if (complaint.assignedWorkerId) {
            return res.status(409).json({
                success: false,
                message: "Complaint already has an assigned worker"
            });
        }

        if (!["Submitted", "Under Review"].includes(complaint.status)) {
            return res.status(409).json({
                success: false,
                message: "Complaint is not eligible for worker assignment"
            });
        }

        const worker = await User.findById(body.workerId).select("name role");

        if (!worker || worker.role !== "worker") {
            return res.status(400).json({
                success: false,
                message: "workerId must refer to a worker account"
            });
        }

        const assignedComplaint = await Complaint.findOneAndUpdate(
            {
                _id: req.params.id,
                status: complaint.status,
                assignedWorkerId: { $exists: false }
            },
            {
                $set: {
                    assignedWorkerId: worker._id,
                    status: "Assigned"
                }
            },
            { new: true, runValidators: true }
        )
            .select("title description category location images status assignedWorkerId createdAt updatedAt")
            .lean();

        if (!assignedComplaint) {
            const complaintStillExists = await Complaint.exists({ _id: req.params.id });

            if (!complaintStillExists) {
                return res.status(404).json({
                    success: false,
                    message: "Complaint not found"
                });
            }

            return res.status(409).json({
                success: false,
                message: "Complaint assignment changed; reload and try again"
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                complaint: {
                    id: assignedComplaint._id.toString(),
                    title: assignedComplaint.title,
                    description: assignedComplaint.description,
                    category: assignedComplaint.category,
                    location: {
                        address: assignedComplaint.location.address,
                        latitude: assignedComplaint.location.latitude,
                        longitude: assignedComplaint.location.longitude
                    },
                    images: assignedComplaint.images,
                    status: assignedComplaint.status,
                    assignedWorkerId: assignedComplaint.assignedWorkerId.toString(),
                    createdAt: assignedComplaint.createdAt,
                    updatedAt: assignedComplaint.updatedAt
                },
                assignedWorker: {
                    id: worker._id.toString(),
                    name: worker.name,
                    role: worker.role
                }
            }
        });
    } catch (error) {
        console.error("Assigning complaint worker failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to assign worker at this time"
        });
    }
}

async function updateWorkerComplaintStatus(req, res, expectedStatus, nextStatus) {
    if (req.user.role !== "worker") {
        return res.status(403).json({
            success: false,
            message: "Only workers can update assigned complaints"
        });
    }

    if (!mongoose.isObjectIdOrHexString(req.params.id)) {
        return res.status(400).json({
            success: false,
            message: "Complaint ID must be a valid MongoDB ObjectId"
        });
    }

    if (!isEmptyRequestBody(req.body)) {
        return res.status(400).json({
            success: false,
            message: "Request body must be empty"
        });
    }

    try {
        const updatedComplaint = await Complaint.findOneAndUpdate(
            {
                _id: req.params.id,
                assignedWorkerId: req.user.id,
                status: expectedStatus
            },
            { $set: { status: nextStatus } },
            { new: true, runValidators: true }
        )
            .select("title description category location images status createdAt updatedAt")
            .lean();

        if (!updatedComplaint) {
            const assignedToWorker = await Complaint.exists({
                _id: req.params.id,
                assignedWorkerId: req.user.id
            });

            if (!assignedToWorker) {
                return res.status(404).json({
                    success: false,
                    message: "Assigned complaint not found"
                });
            }

            return res.status(409).json({
                success: false,
                message: "Complaint is not in the expected status for this action"
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                complaint: serializeComplaint(updatedComplaint)
            }
        });
    } catch (error) {
        console.error("Updating worker complaint status failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to update complaint status at this time"
        });
    }
}

async function startComplaintWork(req, res) {
    return updateWorkerComplaintStatus(req, res, "Assigned", "In Progress");
}

async function claimComplaintCompletion(req, res) {
    return updateWorkerComplaintStatus(req, res, "In Progress", "Work Claimed Completed");
}

async function submitWorkerProgressEvidence(req, res) {
    if (!req.user || req.user.role !== "worker") {
        return res.status(403).json({
            success: false,
            message: "Only workers can submit progress evidence"
        });
    }

    if (!mongoose.isObjectIdOrHexString(req.user.id)) {
        return res.status(401).json({
            success: false,
            message: "Authentication required or token is invalid"
        });
    }

    if (!mongoose.isObjectIdOrHexString(req.params.id)) {
        return res.status(400).json({
            success: false,
            message: "Complaint ID must be a valid MongoDB ObjectId"
        });
    }

    const body = req.body;
    const allowedEvidenceFields = ["note", "evidenceImages"];
    if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).some((field) => !allowedEvidenceFields.includes(field))
    ) {
        return res.status(400).json({
            success: false,
            message: "Request body must contain only note and evidenceImages"
        });
    }

    const errors = {};
    let note;
    if (typeof body.note !== "string") {
        errors.note = "A progress note is required and must be a string";
    } else {
        note = body.note.trim();
        if (note.length === 0 || note.length > 1000) {
            errors.note = "Progress note must contain 1 to 1000 characters";
        }
    }

    let evidenceImages = [];
    if (body.evidenceImages !== undefined) {
        if (!Array.isArray(body.evidenceImages)) {
            errors.evidenceImages = "Evidence images must be an array";
        } else {
            evidenceImages = body.evidenceImages.map((image) => (
                typeof image === "string" ? image.trim() : image
            ));

            if (evidenceImages.length > 5) {
                errors.evidenceImages = "No more than 5 evidence images are allowed";
            } else if (!evidenceImages.every((image) => (
                typeof image === "string" && isHttpUrl(image)
            ))) {
                errors.evidenceImages = "Each evidence image must be a valid HTTP or HTTPS URL";
            }
        }
    }

    if (Object.keys(errors).length > 0) {
        return res.status(400).json({
            success: false,
            message: "Worker progress evidence validation failed",
            errors
        });
    }

    const evidence = {
        note,
        evidenceImages,
        submittedAt: new Date(),
        submittedBy: req.user.id
    };

    try {
        const updatedComplaint = await Complaint.findOneAndUpdate(
            {
                _id: req.params.id,
                assignedWorkerId: req.user.id,
                status: "In Progress",
                [`workerProgressEvidence.${maximumWorkerProgressEvidenceEntries - 1}`]: {
                    $exists: false
                }
            },
            { $push: { workerProgressEvidence: evidence } },
            { new: true, runValidators: true }
        )
            .select("_id status workerProgressEvidence")
            .lean();

        if (!updatedComplaint) {
            const assignedComplaint = await Complaint.findOne({
                _id: req.params.id,
                assignedWorkerId: req.user.id
            })
                .select("_id status workerProgressEvidence")
                .lean();

            if (!assignedComplaint) {
                return res.status(404).json({
                    success: false,
                    message: "Assigned complaint not found"
                });
            }

            if (assignedComplaint.status !== "In Progress") {
                return res.status(409).json({
                    success: false,
                    message: "Complaint is not in progress"
                });
            }

            if (
                Array.isArray(assignedComplaint.workerProgressEvidence)
                && assignedComplaint.workerProgressEvidence.length
                    >= maximumWorkerProgressEvidenceEntries
            ) {
                return res.status(409).json({
                    success: false,
                    message: "Progress evidence limit of 50 entries has been reached"
                });
            }

            return res.status(409).json({
                success: false,
                message: "Progress evidence could not be submitted; refresh and try again"
            });
        }

        const savedEvidence = updatedComplaint.workerProgressEvidence[
            updatedComplaint.workerProgressEvidence.length - 1
        ];

        return res.status(200).json({
            success: true,
            data: {
                complaint: {
                    id: updatedComplaint._id.toString(),
                    status: updatedComplaint.status,
                    progressEvidence: {
                        note: savedEvidence.note,
                        evidenceImages: savedEvidence.evidenceImages,
                        submittedAt: savedEvidence.submittedAt,
                        submittedBy: savedEvidence.submittedBy.toString()
                    }
                }
            }
        });
    } catch (error) {
        console.error("Submitting worker progress evidence failed unexpectedly.");
        return res.status(500).json({
            success: false,
            message: "Unable to submit progress evidence at this time"
        });
    }
}

module.exports = {
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
};
