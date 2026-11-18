const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const allowedFields = ["name", "email", "password"];
const allowedLoginFields = ["email", "password"];
const emailPattern = /^\S+@\S+\.\S+$/;

async function registerUser(req, res) {
    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({
            success: false,
            message: "Request body must be a JSON object"
        });
    }

    if (Object.prototype.hasOwnProperty.call(body, "role")) {
        return res.status(400).json({
            success: false,
            message: "Role cannot be set during registration"
        });
    }

    if (Object.keys(body).some((field) => !allowedFields.includes(field))) {
        return res.status(400).json({
            success: false,
            message: "Only name, email, and password are allowed"
        });
    }

    const errors = {};
    let name;
    let email;

    if (typeof body.name !== "string") {
        errors.name = "Name is required and must be a string";
    } else {
        name = body.name.trim();

        if (name.length < 2 || name.length > 100) {
            errors.name = "Name must be between 2 and 100 characters";
        }
    }

    if (typeof body.email !== "string") {
        errors.email = "Email is required and must be a string";
    } else {
        email = body.email.trim().toLowerCase();

        if (!emailPattern.test(email)) {
            errors.email = "Please provide a valid email address";
        }
    }

    if (typeof body.password !== "string") {
        errors.password = "Password is required and must be a string";
    } else if (body.password.length < 8) {
        errors.password = "Password must be at least 8 characters long";
    }

    if (Object.keys(errors).length > 0) {
        return res.status(400).json({
            success: false,
            message: "Validation failed",
            errors
        });
    }

    try {
        const existingUser = await User.exists({ email });

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists"
            });
        }

        const user = new User({
            name,
            email,
            password: body.password,
            role: "citizen"
        });
        const savedUser = await user.save();

        return res.status(201).json({
            success: true,
            data: {
                user: {
                    id: savedUser._id.toString(),
                    name: savedUser.name,
                    email: savedUser.email,
                    role: savedUser.role,
                    createdAt: savedUser.createdAt
                }
            }
        });
    } catch (error) {
        if (error && error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists"
            });
        }

        console.error("Registration failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to complete registration at this time"
        });
    }
}

async function loginUser(req, res) {
    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({
            success: false,
            message: "Request body must be a JSON object"
        });
    }

    if (Object.keys(body).some((field) => !allowedLoginFields.includes(field))) {
        return res.status(400).json({
            success: false,
            message: "Only email and password are allowed"
        });
    }

    const errors = {};
    let email;

    if (typeof body.email !== "string" || body.email.trim().length === 0) {
        errors.email = "Email is required and must be a non-empty string";
    } else {
        email = body.email.trim().toLowerCase();
    }

    if (typeof body.password !== "string" || body.password.length === 0) {
        errors.password = "Password is required and must be a non-empty string";
    }

    if (Object.keys(errors).length > 0) {
        return res.status(400).json({
            success: false,
            message: "Validation failed",
            errors
        });
    }

    try {
        const user = await User.findOne({ email }).select("+password");

        if (!user || !(await bcrypt.compare(body.password, user.password))) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        const token = jwt.sign(
            { role: user.role },
            process.env.JWT_SECRET,
            {
                algorithm: "HS256",
                subject: user._id.toString(),
                expiresIn: "1h",
                issuer: "civicconnect-ai",
                audience: "civicconnect-ai-api"
            }
        );

        return res.status(200).json({
            success: true,
            data: {
                token,
                user: {
                    id: user._id.toString(),
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    createdAt: user.createdAt
                }
            }
        });
    } catch (error) {
        console.error("Login failed due to an unexpected error.");
        return res.status(500).json({
            success: false,
            message: "Unable to complete login at this time"
        });
    }
}

module.exports = { registerUser, loginUser };
