"use strict";

const mongoose = require("mongoose");
const User = require("../models/User");

const userRoles = User.schema.path("role").enumValues;
const editableRoles = userRoles.filter((role) => role !== "admin");
const safeUserFields = "name email role createdAt updatedAt";
const allowedListQueryFields = ["role", "search", "page", "limit"];
const defaultPage = 1;
const defaultLimit = 20;
const maximumLimit = 100;
const maximumOffset = 100000;
const maximumSearchLength = 100;

function serializeUser(user) {
    return {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
    };
}

function parsePositiveInteger(value, fallback) {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function escapeRegularExpression(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseUserListQuery(query) {
    if (
        !query
        || typeof query !== "object"
        || Array.isArray(query)
        || Object.keys(query).some((field) => !allowedListQueryFields.includes(field))
    ) {
        return null;
    }

    const filter = {};
    if (query.role !== undefined) {
        if (typeof query.role !== "string" || !userRoles.includes(query.role)) {
            return null;
        }
        filter.role = query.role;
    }

    if (query.search !== undefined) {
        if (typeof query.search !== "string") {
            return null;
        }

        const search = query.search.trim();
        if (search.length === 0 || search.length > maximumSearchLength) {
            return null;
        }

        const literalSearch = new RegExp(escapeRegularExpression(search), "i");
        filter.$or = [
            { name: literalSearch },
            { email: literalSearch }
        ];
    }

    const page = parsePositiveInteger(query.page, defaultPage);
    const limit = parsePositiveInteger(query.limit, defaultLimit);
    if (
        page === null
        || limit === null
        || limit > maximumLimit
    ) {
        return null;
    }

    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset) || offset > maximumOffset) {
        return null;
    }

    return { filter, page, limit, offset };
}

async function getAdminUsers(req, res) {
    const options = parseUserListQuery(req.query);
    if (!options) {
        return res.status(400).json({
            success: false,
            message: "User list filters or pagination are invalid"
        });
    }

    try {
        const [users, totalUsers] = await Promise.all([
            User.find(options.filter)
                .select(safeUserFields)
                .sort({ createdAt: -1, _id: -1 })
                .skip(options.offset)
                .limit(options.limit)
                .lean(),
            User.countDocuments(options.filter)
        ]);

        return res.status(200).json({
            success: true,
            data: {
                users: users.map(serializeUser),
                pagination: {
                    currentPage: options.page,
                    totalPages: Math.ceil(totalUsers / options.limit),
                    totalUsers,
                    limit: options.limit
                }
            }
        });
    } catch (error) {
        console.error("Fetching admin user list failed unexpectedly.");
        return res.status(500).json({
            success: false,
            message: "Unable to fetch users at this time"
        });
    }
}

async function getAdminUserById(req, res) {
    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) {
        return res.status(400).json({
            success: false,
            message: "User ID must be a valid MongoDB ObjectId"
        });
    }

    try {
        const user = await User.findById(id).select(safeUserFields).lean();
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        return res.status(200).json({
            success: true,
            data: { user: serializeUser(user) }
        });
    } catch (error) {
        console.error("Fetching admin user failed unexpectedly.");
        return res.status(500).json({
            success: false,
            message: "Unable to fetch user at this time"
        });
    }
}

async function updateAdminUserRole(req, res) {
    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) {
        return res.status(400).json({
            success: false,
            message: "User ID must be a valid MongoDB ObjectId"
        });
    }

    const body = req.body;
    if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).length !== 1
        || !Object.prototype.hasOwnProperty.call(body, "role")
    ) {
        return res.status(400).json({
            success: false,
            message: "Request body must contain only role"
        });
    }

    if (typeof body.role !== "string" || !editableRoles.includes(body.role)) {
        return res.status(400).json({
            success: false,
            message: "Role must be citizen, authority, or worker"
        });
    }

    if (id.toLowerCase() === req.user.id.toLowerCase()) {
        return res.status(403).json({
            success: false,
            message: "Admins cannot change their own role"
        });
    }

    try {
        const updatedUser = await User.findOneAndUpdate(
            { _id: id, role: { $in: editableRoles } },
            { $set: { role: body.role } },
            { new: true, runValidators: true }
        )
            .select(safeUserFields)
            .lean();

        if (!updatedUser) {
            const targetUser = await User.findById(id).select("role").lean();
            if (!targetUser) {
                return res.status(404).json({
                    success: false,
                    message: "User not found"
                });
            }

            if (targetUser.role === "admin") {
                return res.status(409).json({
                    success: false,
                    message: "Admin roles cannot be changed through this endpoint"
                });
            }

            return res.status(409).json({
                success: false,
                message: "User role changed before the update could be completed"
            });
        }

        return res.status(200).json({
            success: true,
            data: { user: serializeUser(updatedUser) }
        });
    } catch (error) {
        console.error("Updating admin-managed user role failed unexpectedly.");
        return res.status(500).json({
            success: false,
            message: "Unable to update user role at this time"
        });
    }
}

module.exports = {
    getAdminUsers,
    getAdminUserById,
    updateAdminUserRole
};
