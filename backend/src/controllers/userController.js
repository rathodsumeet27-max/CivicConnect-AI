function getCurrentUser(req, res) {
    return res.status(200).json({
        success: true,
        data: {
            user: {
                id: req.user.id,
                role: req.user.role
            }
        }
    });
}

module.exports = { getCurrentUser };
