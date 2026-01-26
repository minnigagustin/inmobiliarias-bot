// middleware/validation.js - Input Validation Rules
const { body, param, validationResult } = require("express-validator");

/**
 * Login validation rules
 */
const loginValidation = [
  body('username')
    .trim()
    .notEmpty().withMessage('Usuario requerido')
    .isLength({ max: 50 }).withMessage('Usuario muy largo')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Usuario inválido'),
  body('password')
    .notEmpty().withMessage('Contraseña requerida')
    .isLength({ min: 4, max: 100 }).withMessage('Contraseña inválida'),
];

/**
 * Agent creation validation rules
 */
const createAgentValidation = [
  body('username')
    .trim()
    .notEmpty().withMessage('Usuario requerido')
    .isLength({ min: 3, max: 50 }).withMessage('Usuario debe tener 3-50 caracteres')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Usuario solo puede contener letras, números y guiones bajos'),
  body('password')
    .notEmpty().withMessage('Contraseña requerida')
    .isLength({ min: 6, max: 100 }).withMessage('Contraseña debe tener al menos 6 caracteres'),
  body('name')
    .trim()
    .notEmpty().withMessage('Nombre requerido')
    .isLength({ min: 2, max: 100 }).withMessage('Nombre debe tener 2-100 caracteres'),
  body('role')
    .optional()
    .isIn(['agent', 'superadmin']).withMessage('Rol inválido'),
];

/**
 * Agent update validation rules
 */
const updateAgentValidation = [
  param('id')
    .isInt({ min: 1 }).withMessage('ID inválido'),
  body('username')
    .trim()
    .notEmpty().withMessage('Usuario requerido')
    .isLength({ min: 3, max: 50 }).withMessage('Usuario debe tener 3-50 caracteres')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Usuario solo puede contener letras, números y guiones bajos'),
  body('name')
    .trim()
    .notEmpty().withMessage('Nombre requerido')
    .isLength({ min: 2, max: 100 }).withMessage('Nombre debe tener 2-100 caracteres'),
  body('role')
    .isIn(['agent', 'superadmin']).withMessage('Rol inválido'),
  body('password')
    .optional({ checkFalsy: true })
    .isLength({ min: 6, max: 100 }).withMessage('Contraseña debe tener al menos 6 caracteres'),
];

/**
 * Middleware to handle validation errors
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0].msg,
      errors: errors.array()
    });
  }
  next();
}

/**
 * Middleware to handle validation errors for form submissions (renders login page)
 */
function handleLoginValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render("login", { error: errors.array()[0].msg });
  }
  next();
}

module.exports = {
  loginValidation,
  createAgentValidation,
  updateAgentValidation,
  handleValidationErrors,
  handleLoginValidationErrors,
};
