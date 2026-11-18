const getHealth = (req, res) => {
    res.status(200).json({
        success: true,
        message: "CivicConnect AI backend is running!"
    });
};

module.exports = { getHealth };
