import React, { createContext, useContext, useEffect, useState } from "react";
import { useHistory, useLocation } from "react-router-dom";

const ChatContext = createContext();

const ChatProvider = ({ children }) => {
  const [selectedChat, setSelectedChat] = useState();
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("userInfo"));
    } catch (e) {
      return null;
    }
  });
  const [notification, setNotification] = useState([]);
  const [chats, setChats] = useState();
  const [isAuth, setIsAuth] = useState(false);
  const history = useHistory();
  const location = useLocation();

  useEffect(() => {
    try {
      const userInfo = JSON.parse(localStorage.getItem("userInfo"));
      if (userInfo) {
        setUser(userInfo);
      } else if (location.pathname === "/chats") {
        history.push("/");
      }
    } catch (e) {
      setUser(null);
    }
  }, [location.pathname, history]);

  return (
    <ChatContext.Provider
      value={{
        selectedChat,
        setSelectedChat,
        user,
        setUser,
        notification,
        setNotification,
        chats,
        setChats,
        isAuth,
        setIsAuth,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};

export const ChatState = () => {
  return useContext(ChatContext);
};

export default ChatProvider;
