import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.ServletException;

import java.io.IOException;

import org.eclipse.jetty.websocket.WebSocketServlet;
import org.eclipse.jetty.websocket.WebSocket;
import org.eclipse.jetty.util.log.Log;

public class GmeWebSocketServlet extends WebSocketServlet{
	protected void doGet(HttpServletRequest request, HttpServletResponse response) throws ServletException ,IOException {
		getServletContext().getNamedDispatcher("default").forward(request,response);
	}
	public GmeWebSocket doWebSocketConnect(HttpServletRequest request, String protocol){
    	
        return new GmeWebSocket();
    }
	class GmeWebSocket implements WebSocket,WebSocket.OnTextMessage
    {
        Connection _connection;
        GmeProject _project;

        public GmeWebSocket(){
        	_project = new GmeProject("myproject");
        	GmeLogger.log("ws created");
        }
        
        public void onOpen(Connection connection){
        	_connection=connection;
        	GmeLogger.log("ws connection opened");
        }
        
        public void onClose(int closeCode, String message){
        	GmeLogger.log("ws closed because: "+closeCode+" _cc_ , and with message: "+message);
        }

        public void onMessage( String data)
        {
        	GmeLogger.log("ws got message: "+data);
        	String[] parameters = data.split(":");
        	if(parameters.length<1){
        		try{_connection.sendMessage(getObject(""));}
        		catch(IOException e){}
        	}
        	else{
        		if(parameters[0].equals("getObject")){
        			try{_connection.sendMessage(getObject(parameters[1]));}
            		catch(IOException e){}
        		}
        		else if(parameters[0].equals("getName")){
        			try{_connection.sendMessage(getName());}
            		catch(IOException e){}
        		}
        		else{
        			try{_connection.sendMessage(getObject(""));}
            		catch(IOException e){}
        		}
        	}
        }
        
        private String getObject(String id){
        	GmeLogger.log("ws object (id=\""+id+"\") was requested");
        	if(id.equals(""))
        		return _project.getRoot();
        	return _project.printObject(id);
        }
        
        private String getName(){
        	GmeLogger.log("ws project name was requested");
        	return _project.getName();
        }
    }	
}
