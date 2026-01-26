// middleware/auth.js - Authentication Middleware

/**
 * Require user to be authenticated
 */
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  next();
}

/**
 * Require user to be a super admin
 */
function requireSuperAdmin(req, res, next) {
  if (
    req.session.userRole !== "superadmin" &&
    req.session.userName !== "admin"
  ) {
    return res.status(403).send("Acceso denegado. Solo Super Admins.");
  }
  next();
}

/**
 * Wrap middleware for Socket.IO
 */
const wrap = (middleware) => (socket, next) =>
  middleware(socket.request, {}, next);

/**
 * Socket.IO authentication middleware
 */
function socketAuth(socket, next) {
  const session = socket.request.session;
  if (session && session.userId) {
    socket.agentUser = session;
    next();
  } else {
    next(new Error("unauthorized"));
  }
}

/**
 * Socket.IO super admin authentication middleware
 */
function socketSuperAdminAuth(socket, next) {
  const session = socket.request.session;
  if (session && session.userId && (session.userRole === "superadmin" || session.userName === "admin")) {
    next();
  } else {
    next(new Error("unauthorized - superadmin only"));
  }
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  wrap,
  socketAuth,
  socketSuperAdminAuth,
};
