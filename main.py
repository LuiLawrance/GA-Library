import sys
import user


def main():
    print("\n=== Grand Archive Library ===")

    while True:
        input_user = input(
            "\nEnter your username, 1 to create a new user, 2 to reset your password, or 0 to exit: "
        ).strip()

        if input_user == "0":
            print("Exiting program.")
            sys.exit()

        elif input_user == "1":
            username = input("Enter new username: ").strip()

            while not username:
                print("Username cannot be empty.")
                username = input("Enter new username: ").strip()

            while user.check_user(username):
                print("Username already exists.")
                username = input("Enter new username: ").strip()

            password = input("Enter your password: ").strip()
            user.new_user(username, password)

        elif input_user == "2":
            username = input("Enter your username: ").strip()

            while not username:
                print("Username cannot be empty.")
                username = input("Enter new username: ").strip()

            if user.check_user(username):
                user.reset_password(username)
            else:
                print("Username does not exist.")

        else:
            if user.check_user(input_user):
                input_password = input("Enter your password: ").strip()
                current_user = user.user_login(input_user, input_password)

                if current_user:
                    while True:
                        user_input = input("You have reached the end. Please enter 0 to exit: ")

                        if user_input == "0":
                            break
                        else:
                            print("The only available option is 0")

            else:
                print("User does not exist.")


if __name__ == '__main__':
    main()
