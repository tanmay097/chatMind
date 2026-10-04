const { supabase, supabaseAdmin } = require("../config/supabase");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

// Helper to create JWT token if needed
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || "default_chatmind_secret", {
    expiresIn: process.env.JWT_EXPIRE || "30d",
  });
};

// @desc    Register new user
// @route   POST /api/user/
// @access  Public
// Helper to handle avatar uploads to Supabase storage
const uploadAvatarToSupabase = async (reqPic, reqFiles) => {
  const defaultPic = "https://icon-library.com/images/anonymous-avatar-icon/anonymous-avatar-icon-25.jpg";
  
  try {
    if (reqFiles && reqFiles.pic) {
      const file = reqFiles.pic;
      const fileName = `${Date.now()}_${file.name.replace(/\s+/g, "_")}`;
      const { data: uploadData, error: uploadErr } = await supabaseAdmin.storage
        .from("avatars")
        .upload(fileName, file.data, {
          contentType: file.mimetype,
          upsert: true,
        });
      if (!uploadErr && uploadData) {
        const { data: { publicUrl } } = supabaseAdmin.storage.from("avatars").getPublicUrl(fileName);
        return publicUrl;
      }
    } else if (reqPic && typeof reqPic === "string" && reqPic.startsWith("data:image")) {
      const match = reqPic.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const buffer = Buffer.from(match[2], "base64");
        const ext = mimeType.split("/")[1] || "png";
        const fileName = `${Date.now()}_avatar.${ext}`;
        const { data: uploadData, error: uploadErr } = await supabaseAdmin.storage
          .from("avatars")
          .upload(fileName, buffer, {
            contentType: mimeType,
            upsert: true,
          });
        if (!uploadErr && uploadData) {
          const { data: { publicUrl } } = supabaseAdmin.storage.from("avatars").getPublicUrl(fileName);
          return publicUrl;
        }
      }
    } else if (reqPic && typeof reqPic === "string" && reqPic.startsWith("http")) {
      return reqPic;
    }
  } catch (err) {
    console.warn("Avatar upload notice:", err.message);
  }

  return defaultPic;
};

// @desc    Register new user
// @route   POST /api/user/
// @access  Public
exports.registerUser = async (req, res) => {
  try {
    const { name, email, password, pic } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Please enter all fields" });
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Check if user already exists in profiles
    const { data: existingUser } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("email", trimmedEmail)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ message: "User already exists with this email" });
    }

    const profilePic = await uploadAvatarToSupabase(pic, req.files);
    const passwordHash = await bcrypt.hash(password, 10);

    let authUserId = null;
    let createdProfile = null;

    // Try creating user in Supabase Auth
    try {
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: trimmedEmail,
        password,
        email_confirm: true,
        user_metadata: { name: name.trim(), pic: profilePic },
      });

      if (!authError && authData.user) {
        authUserId = authData.user.id;
      }
    } catch (authErr) {
      console.warn("Supabase Auth admin createUser notice:", authErr.message);
    }

    // Upsert into profiles table to prevent race conditions with database trigger
    const profilePayload = {
      name: name.trim(),
      email: trimmedEmail,
      pic: profilePic,
      is_admin: false,
      password_hash: passwordHash,
      updated_at: new Date().toISOString(),
    };

    if (authUserId) {
      profilePayload.id = authUserId;
      profilePayload.auth_user_id = authUserId;
    }

    const { data: upsertedProfile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .upsert(profilePayload, { onConflict: "email" })
      .select()
      .single();

    if (profileErr || !upsertedProfile) {
      return res.status(500).json({ message: profileErr?.message || "Failed to create user profile" });
    }

    createdProfile = upsertedProfile;
    const token = generateToken(createdProfile.id);

    const responseUser = {
      _id: createdProfile.id,
      id: createdProfile.id,
      name: createdProfile.name,
      email: createdProfile.email,
      pic: createdProfile.pic,
      isAdmin: createdProfile.is_admin,
      token,
    };

    res.cookie("token", token, {
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      httpOnly: true,
    });

    return res.status(201).json(responseUser);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Auth & Login user
// @route   POST /api/user/login
// @access  Public
exports.loginController = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Please Enter Email & Password" });
    }

    // Try Supabase Auth sign-in first
    let token = null;
    let authUser = null;

    try {
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (!signInError && signInData?.session) {
        token = signInData.session.access_token;
        authUser = signInData.user;
      }
    } catch (e) {
      // Fallback to local profile check
    }

    // Retrieve profile from public.profiles
    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (error || !profile) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // If Supabase Auth didn't authenticate directly, check bcrypt hash
    if (!token && profile.password_hash) {
      const isMatch = await bcrypt.compare(password, profile.password_hash);
      if (!isMatch) {
        return res.status(401).json({ message: "Invalid email or password" });
      }
      token = generateToken(profile.id);
    } else if (!token) {
      token = generateToken(profile.id);
    }

    const responseUser = {
      _id: profile.id,
      id: profile.id,
      name: profile.name,
      email: profile.email,
      pic: profile.pic,
      isAdmin: profile.is_admin,
      token,
    };

    res.cookie("token", token, {
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      httpOnly: true,
    });

    return res.status(200).json(responseUser);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Search all users
// @route   GET /api/user?search=
// @access  Protected
exports.allSearchUser = async (req, res) => {
  try {
    const search = req.query.search;
    let query = supabaseAdmin
      .from("profiles")
      .select("id, name, email, pic, is_admin")
      .neq("id", req.user._id);

    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data: users, error } = await query;

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    // Map id to _id for frontend compatibility
    const mappedUsers = (users || []).map((u) => ({
      ...u,
      _id: u.id,
    }));

    return res.status(200).json(mappedUsers);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get current user
// @route   GET /api/user/me
// @access  Protected
exports.loadUser = async (req, res) => {
  try {
    const { data: user, error } = await supabaseAdmin
      .from("profiles")
      .select("id, name, email, pic, is_admin")
      .eq("id", req.user._id)
      .single();

    if (error || !user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      ...user,
      _id: user.id,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Logout user
// @route   GET /api/user/logout
// @access  Public
exports.logoutUser = async (req, res) => {
  res.cookie("token", null, {
    expires: new Date(Date.now()),
    httpOnly: true,
  });

  return res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
};
