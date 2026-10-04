import { Box } from "@chakra-ui/layout";
import { useState } from "react";
import Chatbox from "../components/Chatbox";
import MyChats from "../components/MyChats";
import SideDrawer from "../components/miscellaneous/SideDrawer";
import { ChatState } from "../Context/ChatProvider";
import MetaData from "../components/layouts/MetaData/Metadata";

const Chatpage = () => {
  const [fetchAgain, setFetchAgain] = useState(false); 
  const { user } = ChatState();

  const currentUser =
    user ||
    (() => {
      try {
        return JSON.parse(localStorage.getItem("userInfo"));
      } catch (e) {
        return null;
      }
    })();

  return (
    <>
      <MetaData title="Chat" />
      <div style={{ width: "100%" }}>
        {currentUser && <SideDrawer />}
        <Box
          d="flex"
          justifyContent="space-between"
          w="100%"
          h="91.5vh"
          p="10px"
        >
          {currentUser && <MyChats fetchAgain={fetchAgain} />}
          {currentUser && (
            <Chatbox fetchAgain={fetchAgain} setFetchAgain={setFetchAgain} />
          )}
        </Box>
      </div>
    </>
  );
};

export default Chatpage;
